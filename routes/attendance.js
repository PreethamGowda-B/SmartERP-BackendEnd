const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification } = require('../utils/notificationHelpers');

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

/**
 * Calculate working hours between check-in and check-out
 */
function calculateWorkingHours(checkInTime, checkOutTime) {
  const diffMs = new Date(checkOutTime) - new Date(checkInTime);
  const hours = diffMs / (1000 * 60 * 60);
  return Math.round(hours * 100) / 100; // Round to 2 decimals
}

/**
 * Determine attendance status based on working hours
 */
function determineStatus(workingHours) {
  if (workingHours >= 8) return 'present';
  if (workingHours >= 4) return 'half_day';
  return 'absent';
}

/**
 * Check if check-in is late (after 10 AM)
 */
function isLateCheckIn(checkInTime) {
  const hour = new Date(checkInTime).getHours();
  return hour >= 10;
}

// ─── EMPLOYEE ENDPOINTS ──────────────────────────────────────────────────────

/**
 * POST /api/attendance/check-in
 * Employee checks in for the day
 */
router.post('/check-in', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId || '00000000-0000-0000-0000-000000000000';
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const checkInTime = new Date();
    const isLate = isLateCheckIn(checkInTime);

    // Check if already checked in today
    const existing = await pool.query(
      'SELECT * FROM attendance WHERE user_id = $1 AND date = $2',
      [userId, today]
    );

    if (existing.rows.length > 0 && existing.rows[0].check_in_time) {
      return res.status(400).json({
        message: 'Already checked in today',
        attendance: existing.rows[0]
      });
    }

    // Create or update attendance record
    const result = await pool.query(
      `INSERT INTO attendance (user_id, company_id, date, check_in_time, is_late, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
             ON CONFLICT (user_id, date) 
             DO UPDATE SET check_in_time = $4, is_late = $5, updated_at = NOW()
             RETURNING *`,
      [userId, companyId, today, checkInTime, isLate]
    );

    console.log(`✅ Check-in recorded for user ${userId} at ${checkInTime}`);

    // Send late notification if applicable
    if (isLate) {
      try {
        await createNotification({
          user_id: userId,
          company_id: companyId,
          type: 'attendance_late',
          title: 'Late Check-in',
          message: `You checked in late at ${checkInTime.toLocaleTimeString()}`,
          priority: 'low',
          data: { attendance_id: result.rows[0].id }
        });
      } catch (notifErr) {
        console.error('❌ Failed to send late notification:', notifErr);
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Check-in error:', err);
    res.status(500).json({ message: 'Server error during check-in' });
  }
});

/**
 * POST /api/attendance/check-out
 * Employee checks out for the day
 */
router.post('/check-out', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const today = new Date().toISOString().split('T')[0];
    const checkOutTime = new Date();

    // Get today's attendance record
    const existing = await pool.query(
      'SELECT * FROM attendance WHERE user_id = $1 AND date = $2',
      [userId, today]
    );

    if (existing.rows.length === 0 || !existing.rows[0].check_in_time) {
      return res.status(400).json({ message: 'Please check in first' });
    }

    if (existing.rows[0].check_out_time) {
      return res.status(400).json({
        message: 'Already checked out today',
        attendance: existing.rows[0]
      });
    }

    const checkInTime = existing.rows[0].check_in_time;
    const workingHours = calculateWorkingHours(checkInTime, checkOutTime);
    const status = determineStatus(workingHours);

    // Update attendance record
    const result = await pool.query(
      `UPDATE attendance 
             SET check_out_time = $1, working_hours = $2, status = $3, updated_at = NOW()
             WHERE user_id = $4 AND date = $5
             RETURNING *`,
      [checkOutTime, workingHours, status, userId, today]
    );

    console.log(`✅ Check-out recorded for user ${userId}. Hours: ${workingHours}, Status: ${status}`);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Check-out error:', err);
    res.status(500).json({ message: 'Server error during check-out' });
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
        status: null
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
 * Get attendance history for employee
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

    // Create correction request
    const result = await pool.query(
      `INSERT INTO attendance_corrections 
             (attendance_id, user_id, requested_check_in, requested_check_out, reason, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING *`,
      [attendance_id, userId, requested_check_in, requested_check_out, reason]
    );

    // Notify owner (get first owner)
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
                a.is_late
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
    const status = determineStatus(workingHours);

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
          is_late: row.is_late
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

module.exports = router;