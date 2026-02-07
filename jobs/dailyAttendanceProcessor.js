const cron = require('node-cron');
const { pool } = require('../db');

/**
 * Daily Attendance Processing Job
 * Runs every day at 7:30 PM (19:30)
 * 
 * Tasks:
 * 1. Auto clock-out employees who didn't clock out
 * 2. Mark absentees
 * 3. Lock attendance records for the day
 */

function startDailyAttendanceProcessor() {
    // Run daily at 7:30 PM IST (19:30)
    cron.schedule('30 19 * * *', async () => {
        const targetDate = new Date().toISOString().split('T')[0];

        console.log(`\n${'='.repeat(60)}`);
        console.log(`🕐 DAILY ATTENDANCE PROCESSING - ${targetDate}`);
        console.log(`${'='.repeat(60)}\n`);

        try {
            // 1. Auto clock-out employees who didn't clock out
            console.log('📋 Step 1: Auto clock-out employees...');
            const autoClockOutResult = await pool.query(`
                UPDATE attendance
                SET check_out_time = (date || ' 19:00:00')::timestamp,
                    is_auto_clocked_out = TRUE,
                    working_hours = EXTRACT(EPOCH FROM (
                        (date || ' 19:00:00')::timestamp - check_in_time
                    )) / 3600,
                    status = CASE 
                        WHEN EXTRACT(EPOCH FROM ((date || ' 19:00:00')::timestamp - check_in_time)) / 3600 >= 8 THEN 'present'
                        ELSE 'half_day'
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

            // TODO: Send alert notification to admin/owner
        }
    }, {
        timezone: "Asia/Kolkata" // IST timezone
    });

    console.log('✅ Daily attendance processor scheduled (7:30 PM IST)');
}

module.exports = { startDailyAttendanceProcessor };
