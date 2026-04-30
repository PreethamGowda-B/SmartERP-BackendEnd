const cron = require('node-cron');
const { pool } = require('../db');
const { createNotificationForOwners } = require('../utils/notificationHelpers');

/**
 * Daily Attendance Processing Job
 * Runs every day at 7:05 PM IST (13:35 UTC)
 * 
 * Tasks:
 * 1. Auto clock-out employees who didn't clock out
 * 2. Mark absentees
 * 3. Lock attendance records for the day
 */

function startDailyAttendanceProcessor() {
    // Run daily at 7:05 PM IST = 13:35 UTC (5-min grace after 7 PM cutoff)
    // Using UTC directly to avoid node-cron timezone reliability issues on hosted servers
    cron.schedule('35 13 * * *', async () => {
        // Double-check we're running at the right IST time
        const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const targetDate = nowIST.toISOString().split('T')[0];

        console.log(`\n${'='.repeat(60)}`);
        console.log(`🕐 DAILY ATTENDANCE PROCESSING - ${targetDate}`);
        console.log(`${'='.repeat(60)}\n`);

        try {
            // 1. Auto clock-out employees who didn't clock out
            console.log('📋 Step 1: Auto clock-out employees...');
            const autoClockOutResult = await pool.query(`
                UPDATE attendance
                SET check_out_time = (date || ' 19:00:00 Asia/Kolkata')::timestamptz AT TIME ZONE 'UTC',
                    is_auto_clocked_out = TRUE,
                    working_hours = EXTRACT(EPOCH FROM (
                        ((date || ' 19:00:00 Asia/Kolkata')::timestamptz AT TIME ZONE 'UTC') - check_in_time
                    )) / 3600,
                    status = CASE
                        WHEN EXTRACT(HOUR FROM check_in_time) >= 13 THEN 'half_day'
                        WHEN EXTRACT(HOUR FROM check_in_time) > 9
                          OR (EXTRACT(HOUR FROM check_in_time) = 9 AND EXTRACT(MINUTE FROM check_in_time) > 0)
                          THEN 'late'
                        ELSE 'present'
                    END,
                    updated_at = NOW()
                WHERE date = $1 
                  AND check_in_time IS NOT NULL 
                  AND check_out_time IS NULL
                  AND is_processed = FALSE
                RETURNING id, user_id
            `, [targetDate]);

            console.log(`   ✅ Auto clocked-out ${autoClockOutResult.rows.length} employees`);
            if (autoClockOutResult.rows.length > 0) {
                console.log(`   📝 User IDs: ${autoClockOutResult.rows.map(r => r.user_id).join(', ')}`);
            }

            // 2. Mark absentees
            console.log('\n📋 Step 2: Marking absentees...');
            const absenteeResult = await pool.query(`
                INSERT INTO attendance (user_id, company_id, date, status, is_processed, created_at, updated_at)
                SELECT u.id, u.company_id, $1, 'absent', FALSE, NOW(), NOW()
                FROM users u
                WHERE u.role = 'employee'
                  AND u.company_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM attendance a 
                      WHERE a.user_id = u.id AND a.date = $1
                  )
                RETURNING id, user_id
            `, [targetDate]);

            console.log(`   ✅ Marked ${absenteeResult.rows.length} employees as absent`);
            if (absenteeResult.rows.length > 0) {
                console.log(`   📝 User IDs: ${absenteeResult.rows.map(r => r.user_id).join(', ')}`);
            }

            // 3. Lock all records for the day
            console.log('\n📋 Step 3: Locking attendance records...');
            const lockResult = await pool.query(`
                UPDATE attendance
                SET is_processed = TRUE, processed_at = NOW()
                WHERE date = $1 AND is_processed = FALSE
                RETURNING id
            `, [targetDate]);

            console.log(`   ✅ Locked ${lockResult.rows.length} attendance records`);

            // Summary
            console.log(`\n${'='.repeat(60)}`);
            console.log('✅ DAILY PROCESSING COMPLETED SUCCESSFULLY');
            console.log(`   Date: ${targetDate}`);
            console.log(`   Auto Clock-Outs: ${autoClockOutResult.rows.length}`);
            console.log(`   Absentees Marked: ${absenteeResult.rows.length}`);
            console.log(`   Records Locked: ${lockResult.rows.length}`);
            console.log(`${'='.repeat(60)}\n`);

        } catch (err) {
            console.error('\n❌ DAILY PROCESSING FAILED');
            console.error('Error:', err.message);
            console.error('Stack:', err.stack);
            console.error(`${'='.repeat(60)}\n`);

            // ✅ Send alert notification to admin/owner
            await createNotificationForOwners({
                company_id: null, // Global alert
                type: 'alert_attendance_processor_failed',
                title: '❌ Attendance Processor Failed',
                message: `The daily attendance processor failed on ${targetDate}. Error: ${err.message}`,
                priority: 'high'
            });
        }
    }, {
        scheduled: true
    });

    console.log('✅ Daily attendance processor scheduled (7:05 PM IST / 13:35 UTC)');
}

module.exports = { startDailyAttendanceProcessor };
