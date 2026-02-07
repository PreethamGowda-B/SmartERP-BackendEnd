const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification } = require('../utils/notificationHelpers');

// ─── ENTERPRISE ATTENDANCE SYSTEM ────────────────────────────────────────────
// Shift Times: 9:00 AM - 7:00 PM
// Auto clock-out, half-day detection, biometric support, daily processing

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

/**
 * Calculate working hours between clock-in and clock-out
 */
function calculateWorkingHours(clockInTime, clockOutTime) {
  const diffMs = new Date(clockOutTime) - new Date(clockInTime);
  const hours = diffMs / (1000 * 60 * 60);
  return Math.round(hours * 100) / 100; // Round to 2 decimals
}

/**
 * Check if clock-in is late (after 9:00 AM)
 * Enterprise Rule: Shift starts at 9:00 AM
 */
function isLateCheckIn(clockInTime) {
  const hour = new Date(clockInTime).getHours();
  const minute = new Date(clockInTime).getMinutes();
  // Late if after 9:00 AM (9:01 AM onwards)
  return hour > 9 || (hour === 9 && minute > 0);
}

/**
 * Check if clock-out is before shift end (7:00 PM)
 * Used for half-day detection
 */
function isEarlyClockOut(clockOutTime) {
  const hour = new Date(clockOutTime).getHours();
  // Early if before 7:00 PM (before 19:00)
  return hour < 19;
}

/**
 * Determine attendance status based on clock times and working hours
 * Enterprise Rules:
 * - Clock out before 7 PM → Half Day
 * - Clock out at/after 7 PM with >= 8 hours → Present
 * - Clock out at/after 7 PM with < 8 hours → Half Day
 */
function determineStatus(clockInTime, clockOutTime, workingHours) {
  const isEarly = isEarlyClockOut(clockOutTime);

  if (isEarly) {
    return 'half_day'; // Clocked out before 7 PM
  }

  if (workingHours >= 8) {
    return 'present'; // Full day
  }

  return 'half_day'; // Less than 8 hours
}

// ─── EMPLOYEE ENDPOINTS ──────────────────────────────────────────────────────

/**
 * POST /api/attendance/clock-in
 * Employee clocks in for the day (Enterprise: 9 AM shift start)
 */
router.post('/clock-in', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId || '00000000-0000-0000-0000-000000000000';
    const { biometric_device_id, method = 'manual' } = req.body;
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const clockInTime = new Date();
    const currentHour = clockInTime.getHours();

    // Enterprise Rule: Block clock-in outside shift hours (9 AM - 7 PM)
    if (currentHour < 9 || currentHour >= 19) {
      return res.status(400).json({
        message: 'Clock-in is only allowed between 9:00 AM and 7:00 PM',
        current_time: clockInTime.toLocaleTimeString()
      });
    }

    const isLate = isLateCheckIn(clockInTime);

    // Check if already clocked in today
    const existing = await pool.query(
      'SELECT * FROM attendance WHERE user_id = $1 AND date = $2',
      [userId, today]
    );

    if (existing.rows.length > 0 && existing.rows[0].check_in_time) {
      return res.status(400).json({
        message: 'Already clocked in today',
        attendance: existing.rows[0]
      });
    }

    // Create or update attendance record with enterprise fields
    const result = await pool.query(
      `INSERT INTO attendance 
             (user_id, company_id, date, check_in_time, is_late, clock_in_method, biometric_device_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
             ON CONFLICT (user_id, date) 
             DO UPDATE SET check_in_time = $4, is_late = $5, clock_in_method = $6, biometric_device_id = $7, updated_at = NOW()
             RETURNING *`,
      [userId, companyId, today, clockInTime, isLate, method, biometric_device_id]
    );

    console.log(`✅ Clock-in recorded for user ${userId} at ${clockInTime.toLocaleTimeString()} (${method})`);

    // Send late notification if applicable (after 9 AM)
    if (isLate) {
      try {
        await createNotification({
          user_id: userId,
          company_id: companyId,
          type: 'attendance_late',
          title: 'Late Clock-In',
          message: `You clocked in late at ${clockInTime.toLocaleTimeString()}. Shift starts at 9:00 AM.`,
          priority: 'low',
          data: { attendance_id: result.rows[0].id }
        });
      } catch (notifErr) {
        console.error('❌ Failed to send late notification:', notifErr);
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Clock-in error:', err);
    res.status(500).json({ message: 'Server error during clock-in' });
  }
});

/**
 * POST /api/attendance/clock-out
 * Employee clocks out for the day (Enterprise: 7 PM shift end, half-day detection)
 */
router.post('/clock-out', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { biometric_device_id, method = 'manual' } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const clockOutTime = new Date();

    // Get today's attendance record
    const existing = await pool.query(
      'SELECT * FROM attendance WHERE user_id = $1 AND date = $2',
      [userId, today]
    );

    if (existing.rows.length === 0 || !existing.rows[0].check_in_time) {
      return res.status(400).json({ message: 'Please clock in first' });
    }

    if (existing.rows[0].check_out_time) {
      return res.status(400).json({
        message: 'Already clocked out today',
        attendance: existing.rows[0]
      });
    }

    const clockInTime = existing.rows[0].check_in_time;
    const workingHours = calculateWorkingHours(clockInTime, clockOutTime);
    const status = determineStatus(clockInTime, clockOutTime, workingHours);

    // Update attendance record
    const result = await pool.query(
      `UPDATE attendance 
             SET check_out_time = $1, working_hours = $2, status = $3, clock_out_method = $4, biometric_device_id = COALESCE($5, biometric_device_id), updated_at = NOW()
             WHERE user_id = $6 AND date = $7
             RETURNING *`,
      [clockOutTime, workingHours, status, method, biometric_device_id, userId, today]
    );

    console.log(`✅ Clock-out recorded for user ${userId}. Hours: ${workingHours}, Status: ${status} (${method})`);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Clock-out error:', err);
    res.status(500).json({ message: 'Server error during clock-out' });
  }
});

/**
 * GET /api/attendance/today
 * Get today's attendance status for employee
 */
router.get('/today', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const today = new Date().toISOString().split('T')[0];

    const result = await pool.query(
      'SELECT * FROM attendance WHERE user_id = $1 AND date = $2',
      [userId, today]
    );

    if (result.rows.length === 0) {
      return res.json({
        date: today,
        check_in_time: null,
        check_out_time: null,
        working_hours: null,
        status: null,
        is_late: false,
        is_auto_clocked_out: false
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error fetching today\'s attendance:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * GET /api/attendance/history
 * Get attendance history for employee (only own records)
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { month, year } = req.query;

    let query = 'SELECT * FROM attendance WHERE user_id = $1';
    const params = [userId];

    if (month && year) {
      query += ' AND EXTRACT(MONTH FROM date) = $2 AND EXTRACT(YEAR FROM date) = $3';
      params.push(month, year);
    }

    query += ' ORDER BY date DESC LIMIT 100';

    const result = await pool.query(query, params);

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching attendance history:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * POST /api/attendance/corrections
 * Request attendance correction
 */
router.post('/corrections', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId || '00000000-0000-0000-0000-000000000000';
    const { attendance_id, requested_check_in, requested_check_out, reason } = req.body;

    if (!attendance_id || !reason) {
      return res.status(400).json({ message: 'attendance_id and reason are required' });
    }

    // Verify attendance belongs to user
    const attendance = await pool.query(
      'SELECT * FROM attendance WHERE id = $1 AND user_id = $2',
      [attendance_id, userId]
    );

    if (attendance.rows.length === 0) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    // Check if record is processed (locked)
    if (attendance.rows[0].is_processed) {
      return res.status(403).json({ message: 'Cannot request correction for processed records' });
    }

    // Create correction request
    const result = await pool.query(
      `INSERT INTO attendance_corrections 
             (attendance_id, user_id, requested_check_in, requested_check_out, reason, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING *`,
      [attendance_id, userId, requested_check_in, requested_check_out, reason]
    );

    // Notify owner
    try {
      const ownerResult = await pool.query(
        "SELECT id FROM users WHERE role = 'owner' LIMIT 1"
      );

      if (ownerResult.rows.length > 0) {
        await createNotification({
          user_id: ownerResult.rows[0].id,
          company_id: companyId,
          type: 'attendance_correction_request',
          title: 'Attendance Correction Request',
          message: `Employee has requested attendance correction`,
          priority: 'medium',
          data: { correction_id: result.rows[0].id, user_id: userId }
        });
      }
    } catch (notifErr) {
      console.error('❌ Failed to send correction request notification:', notifErr);
    }

    console.log(`✅ Correction request created for attendance ${attendance_id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error creating correction request:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── OWNER ENDPOINTS ─────────────────────────────────────────────────────────

/**
 * GET /api/attendance/overview
 * Get today's attendance overview for all employees (Owner only)
 */
router.get('/overview', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const today = new Date().toISOString().split('T')[0];

    const result = await pool.query(
      `SELECT 
                u.id as user_id,
                u.name as employee_name,
                u.email as employee_email,
                a.id as attendance_id,
                a.date,
                a.check_in_time,
                a.check_out_time,
                a.working_hours,
                a.status,
                a.is_late,
                a.is_auto_clocked_out
             FROM users u
             LEFT JOIN attendance a ON u.id = a.user_id AND a.date = $1
             WHERE u.role = 'employee'
             ORDER BY u.name ASC`,
      [today]
    );

    // Calculate summary
    const summary = {
      total: result.rows.length,
      present: result.rows.filter(r => r.check_in_time).length,
      absent: result.rows.filter(r => !r.check_in_time).length,
      late: result.rows.filter(r => r.is_late).length
    };

    res.json({ summary, employees: result.rows });
  } catch (err) {
    console.error('❌ Error fetching attendance overview:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * GET /api/attendance/employee/:userId
 * Get monthly attendance for specific employee (Owner only)
 */
router.get('/employee/:userId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { userId } = req.params;
    const { month, year } = req.query;

    const currentMonth = month || new Date().getMonth() + 1;
    const currentYear = year || new Date().getFullYear();

    // Get attendance records
    const records = await pool.query(
      `SELECT * FROM attendance 
             WHERE user_id = $1 
               AND EXTRACT(MONTH FROM date) = $2 
               AND EXTRACT(YEAR FROM date) = $3
             ORDER BY date DESC`,
      [userId, currentMonth, currentYear]
    );

    // Calculate summary
    const summary = {
      total_days: records.rows.length,
      present_days: records.rows.filter(r => r.status === 'present').length,
      absent_days: records.rows.filter(r => r.status === 'absent').length,
      half_days: records.rows.filter(r => r.status === 'half_day').length,
      total_hours: records.rows.reduce((sum, r) => sum + (parseFloat(r.working_hours) || 0), 0),
      late_days: records.rows.filter(r => r.is_late).length
    };

    res.json({ summary, records: records.rows });
  } catch (err) {
    console.error('❌ Error fetching employee attendance:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * GET /api/attendance/calendar/:userId
 * Get calendar data for employee (Owner only)
 */
router.get('/calendar/:userId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { userId } = req.params;
    const { month, year } = req.query;

    const currentMonth = month || new Date().getMonth() + 1;
    const currentYear = year || new Date().getFullYear();

    const records = await pool.query(
      `SELECT date, check_in_time, check_out_time, working_hours, status, is_late, is_auto_clocked_out
             FROM attendance 
             WHERE user_id = $1 
               AND EXTRACT(MONTH FROM date) = $2 
               AND EXTRACT(YEAR FROM date) = $3
             ORDER BY date ASC`,
      [userId, currentMonth, currentYear]
    );

    res.json(records.rows);
  } catch (err) {
    console.error('❌ Error fetching calendar data:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * PATCH /api/attendance/:id
 * Manually edit attendance record (Owner only)
 */
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { id } = req.params;
    const { check_in_time, check_out_time, status, notes } = req.body;
    const editedBy = req.user.userId || req.user.id;

    // Check if record is processed (locked)
    const existing = await pool.query('SELECT is_processed FROM attendance WHERE id = $1', [id]);
    if (existing.rows.length > 0 && existing.rows[0].is_processed) {
      return res.status(403).json({ message: 'Cannot edit processed records' });
    }

    // Calculate working hours if both times provided
    let workingHours = null;
    if (check_in_time && check_out_time) {
      workingHours = calculateWorkingHours(check_in_time, check_out_time);
    }

    const result = await pool.query(
      `UPDATE attendance 
             SET check_in_time = COALESCE($1, check_in_time),
                 check_out_time = COALESCE($2, check_out_time),
                 working_hours = COALESCE($3, working_hours),
                 status = COALESCE($4, status),
                 notes = COALESCE($5, notes),
                 is_manual = TRUE,
                 edited_by = $6,
                 updated_at = NOW()
             WHERE id = $7
             RETURNING *`,
      [check_in_time, check_out_time, workingHours, status, notes, editedBy, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    console.log(`✅ Attendance ${id} manually edited by owner`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error editing attendance:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * PATCH /api/attendance/corrections/:id/approve
 * Approve correction request (Owner only)
 */
router.patch('/corrections/:id/approve', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { id } = req.params;
    const reviewedBy = req.user.userId || req.user.id;
    const companyId = req.user.companyId || '00000000-0000-0000-0000-000000000000';

    // Get correction request
    const correction = await pool.query(
      'SELECT * FROM attendance_corrections WHERE id = $1',
      [id]
    );

    if (correction.rows.length === 0) {
      return res.status(404).json({ message: 'Correction request not found' });
    }

    const correctionData = correction.rows[0];

    // Update attendance record
    const workingHours = calculateWorkingHours(
      correctionData.requested_check_in,
      correctionData.requested_check_out
    );
    const status = determineStatus(
      correctionData.requested_check_in,
      correctionData.requested_check_out,
      workingHours
    );

    await pool.query(
      `UPDATE attendance 
             SET check_in_time = $1,
                 check_out_time = $2,
                 working_hours = $3,
                 status = $4,
                 is_manual = TRUE,
                 edited_by = $5,
                 updated_at = NOW()
             WHERE id = $6`,
      [correctionData.requested_check_in, correctionData.requested_check_out,
        workingHours, status, reviewedBy, correctionData.attendance_id]
    );

    // Update correction status
    const result = await pool.query(
      `UPDATE attendance_corrections 
             SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
             WHERE id = $2
             RETURNING *`,
      [reviewedBy, id]
    );

    // Notify employee
    try {
      await createNotification({
        user_id: correctionData.user_id,
        company_id: companyId,
        type: 'attendance_correction_approved',
        title: 'Attendance Correction Approved',
        message: 'Your attendance correction request has been approved',
        priority: 'medium',
        data: { correction_id: id }
      });
    } catch (notifErr) {
      console.error('❌ Failed to send approval notification:', notifErr);
    }

    console.log(`✅ Correction ${id} approved`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error approving correction:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * PATCH /api/attendance/corrections/:id/reject
 * Reject correction request (Owner only)
 */
router.patch('/corrections/:id/reject', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { id } = req.params;
    const { rejection_reason } = req.body;
    const reviewedBy = req.user.userId || req.user.id;
    const companyId = req.user.companyId || '00000000-0000-0000-0000-000000000000';

    // Get correction request
    const correction = await pool.query(
      'SELECT * FROM attendance_corrections WHERE id = $1',
      [id]
    );

    if (correction.rows.length === 0) {
      return res.status(404).json({ message: 'Correction request not found' });
    }

    const correctionData = correction.rows[0];

    // Update correction status
    const result = await pool.query(
      `UPDATE attendance_corrections 
             SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), rejection_reason = $2
             WHERE id = $3
             RETURNING *`,
      [reviewedBy, rejection_reason, id]
    );

    // Notify employee
    try {
      await createNotification({
        user_id: correctionData.user_id,
        company_id: companyId,
        type: 'attendance_correction_rejected',
        title: 'Attendance Correction Rejected',
        message: rejection_reason || 'Your attendance correction request has been rejected',
        priority: 'low',
        data: { correction_id: id }
      });
    } catch (notifErr) {
      console.error('❌ Failed to send rejection notification:', notifErr);
    }

    console.log(`✅ Correction ${id} rejected`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error rejecting correction:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * GET /api/attendance/report
 * Generate attendance report (Owner only)
 */
router.get('/report', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { month, year, employee_id } = req.query;
    const currentMonth = month || new Date().getMonth() + 1;
    const currentYear = year || new Date().getFullYear();

    let query = `
            SELECT 
                u.id as user_id,
                u.name as employee_name,
                u.email as employee_email,
                a.*
            FROM users u
            LEFT JOIN attendance a ON u.id = a.user_id
            WHERE u.role = 'employee'
              AND EXTRACT(MONTH FROM a.date) = $1
              AND EXTRACT(YEAR FROM a.date) = $2
        `;

    const params = [currentMonth, currentYear];

    if (employee_id) {
      query += ' AND u.id = $3';
      params.push(employee_id);
    }

    query += ' ORDER BY u.name ASC, a.date DESC';

    const result = await pool.query(query, params);

    // Group by employee
    const reportData = {};
    result.rows.forEach(row => {
      if (!reportData[row.user_id]) {
        reportData[row.user_id] = {
          employee: {
            id: row.user_id,
            name: row.employee_name,
            email: row.employee_email
          },
          records: [],
          summary: {
            present_days: 0,
            absent_days: 0,
            half_days: 0,
            total_hours: 0,
            late_days: 0
          }
        };
      }

      if (row.id) {
        reportData[row.user_id].records.push({
          date: row.date,
          check_in: row.check_in_time,
          check_out: row.check_out_time,
          hours: row.working_hours,
          status: row.status,
          is_late: row.is_late,
          is_auto_clocked_out: row.is_auto_clocked_out
        });

        // Update summary
        if (row.status === 'present') reportData[row.user_id].summary.present_days++;
        if (row.status === 'absent') reportData[row.user_id].summary.absent_days++;
        if (row.status === 'half_day') reportData[row.user_id].summary.half_days++;
        if (row.is_late) reportData[row.user_id].summary.late_days++;
        reportData[row.user_id].summary.total_hours += parseFloat(row.working_hours) || 0;
      }
    });

    res.json({
      month: currentMonth,
      year: currentYear,
      employees: Object.values(reportData)
    });
  } catch (err) {
    console.error('❌ Error generating report:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── DAILY PROCESSING ENDPOINT ───────────────────────────────────────────────

/**
 * POST /api/attendance/process-daily
 * Run daily attendance processing (Admin/System only)
 * - Auto clock-out employees at 7 PM
 * - Mark absentees
 * - Lock records
 */
router.post('/process-daily', authenticateToken, async (req, res) => {
  try {
    // Only allow admin/owner to manually trigger
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { date } = req.body;
    const targetDate = date || new Date().toISOString().split('T')[0];

    console.log(`🕐 Running daily attendance processing for ${targetDate}...`);

    // 1. Auto clock-out employees who didn't clock out
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
            RETURNING id
        `, [targetDate]);

    console.log(`✅ Auto clocked-out ${autoClockOutResult.rows.length} employees`);

    // 2. Mark absentees
    const absenteeResult = await pool.query(`
            INSERT INTO attendance (user_id, company_id, date, status, is_processed, created_at, updated_at)
            SELECT u.id, u.company_id, $1, 'absent', FALSE, NOW(), NOW()
            FROM users u
            WHERE u.role = 'employee'
              AND NOT EXISTS (
                  SELECT 1 FROM attendance a 
                  WHERE a.user_id = u.id AND a.date = $1
              )
            RETURNING id
        `, [targetDate]);

    console.log(`✅ Marked ${absenteeResult.rows.length} employees as absent`);

    // 3. Mark all records as processed (locked)
    const lockResult = await pool.query(`
            UPDATE attendance
            SET is_processed = TRUE, processed_at = NOW()
            WHERE date = $1 AND is_processed = FALSE
            RETURNING id
        `, [targetDate]);

    console.log(`✅ Locked ${lockResult.rows.length} attendance records`);

    res.json({
      success: true,
      date: targetDate,
      auto_clocked_out: autoClockOutResult.rows.length,
      marked_absent: absenteeResult.rows.length,
      records_locked: lockResult.rows.length
    });
  } catch (err) {
    console.error('❌ Daily processing error:', err);
    res.status(500).json({ message: 'Server error during daily processing' });
  }
});

// ─── BIOMETRIC INTEGRATION ENDPOINTS ─────────────────────────────────────────

/**
 * POST /api/attendance/biometric/webhook
 * Webhook for biometric devices to send attendance data
 */
router.post('/biometric/webhook', async (req, res) => {
  try {
    const { device_id, employee_id, action, timestamp, biometric_data } = req.body;

    if (!device_id || !employee_id || !action) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Verify device is registered
    const device = await pool.query(
      'SELECT * FROM biometric_devices WHERE device_id = $1 AND is_active = TRUE',
      [device_id]
    );

    if (device.rows.length === 0) {
      return res.status(404).json({ message: 'Device not registered or inactive' });
    }

    // Verify employee exists
    const employee = await pool.query(
      'SELECT id, company_id FROM users WHERE id = $1',
      [employee_id]
    );

    if (employee.rows.length === 0) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const today = new Date(timestamp || Date.now()).toISOString().split('T')[0];
    const actionTime = new Date(timestamp || Date.now());

    if (action === 'clock_in') {
      const isLate = isLateCheckIn(actionTime);

      const result = await pool.query(
        `INSERT INTO attendance 
                 (user_id, company_id, date, check_in_time, is_late, clock_in_method, biometric_device_id, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 'biometric', $6, NOW(), NOW())
                 ON CONFLICT (user_id, date) 
                 DO UPDATE SET check_in_time = $4, is_late = $5, clock_in_method = 'biometric', biometric_device_id = $6, updated_at = NOW()
                 RETURNING *`,
        [employee_id, employee.rows[0].company_id, today, actionTime, isLate, device_id]
      );

      console.log(`✅ Biometric clock-in: ${employee_id} via ${device_id}`);
      return res.json({ success: true, attendance: result.rows[0] });
    }

    if (action === 'clock_out') {
      const existing = await pool.query(
        'SELECT * FROM attendance WHERE user_id = $1 AND date = $2',
        [employee_id, today]
      );

      if (existing.rows.length === 0 || !existing.rows[0].check_in_time) {
        return res.status(400).json({ message: 'No clock-in record found' });
      }

      const clockInTime = existing.rows[0].check_in_time;
      const workingHours = calculateWorkingHours(clockInTime, actionTime);
      const status = determineStatus(clockInTime, actionTime, workingHours);

      const result = await pool.query(
        `UPDATE attendance 
                 SET check_out_time = $1, working_hours = $2, status = $3, clock_out_method = 'biometric', biometric_device_id = $4, updated_at = NOW()
                 WHERE user_id = $5 AND date = $6
                 RETURNING *`,
        [actionTime, workingHours, status, device_id, employee_id, today]
      );

      console.log(`✅ Biometric clock-out: ${employee_id} via ${device_id}`);
      return res.json({ success: true, attendance: result.rows[0] });
    }

    res.status(400).json({ message: 'Invalid action' });
  } catch (err) {
    console.error('❌ Biometric webhook error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;