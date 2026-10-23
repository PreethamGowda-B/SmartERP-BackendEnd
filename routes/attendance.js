const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');
const { requireFeature } = require('../middleware/featureGuard');
const { createNotification, createNotificationForOwners } = require('../utils/notificationHelpers');
const AttendancePolicy = require('../services/attendancePolicyService');
const { redisClient } = require('../utils/redis');
const { storage } = require('../middleware/als');
const BiometricWebhookAuth = require('../services/biometricWebhookAuth');

// company_id helper
function safeCompanyId(value) {
  if (!value) return null;
  // If it's a number or numeric string, return as Number
  if (!isNaN(value)) return Number(value);
  // If it's a UUID, return as is
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof value === 'string' && UUID_RE.test(value)) return value;
  return null;
}

// ─── ENTERPRISE ATTENDANCE SYSTEM ────────────────────────────────────────────
// Shift Times: 9:00 AM - 7:00 PM
// Auto clock-out, half-day detection, biometric support, daily processing

// ─── TRANSACTION AND RESPONSE HELPERS ────────────────────────────────────────

async function withAttendanceTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function formatPolicyTime(instant, timezone) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(instant));
}

function requireEmployee(req, res) {
  if ((req.user?.role || '').toLowerCase() !== 'employee') {
    res.status(403).json({ message: 'Employee attendance action required' });
    return false;
  }
  if (!req.user?.companyId && !req.user?.company_id) {
    res.status(403).json({ message: 'Missing company affiliation' });
    return false;
  }
  return true;
}

router.get('/policy', authenticateToken, async (req, res) => {
  try {
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    if (!companyId) return res.status(403).json({ message: 'Missing company affiliation' });
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const now = new Date();
    const role = (req.user.role || '').toLowerCase();
    let attendance = null;
    let eligibility = null;
    if (role === 'employee') {
      const workDate = AttendancePolicy.localDate(now, policy.timezone);
      const result = await pool.query('SELECT * FROM attendance WHERE user_id = $1 AND company_id::text = $2::text AND date = $3 ORDER BY created_at ASC LIMIT 2', [req.user.userId || req.user.id, String(companyId), workDate]);
      if (result.rows.length > 1) return res.status(409).json({ message: 'Multiple attendance records exist for this work date; owner review is required' });
      attendance = result.rows[0] || null;
      eligibility = attendance?.check_in_time
        ? { allowed: false, code: 'already_clocked_in', reason: 'Attendance is already recorded for today' }
        : AttendancePolicy.evaluateClockIn(now, policy);
    } else if (!['owner', 'admin', 'hr', 'superadmin'].includes(role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    res.json({ policy, work_date: AttendancePolicy.localDate(now, policy.timezone), eligibility, attendance });
  } catch (err) {
    console.error('❌ Error reading attendance policy:', err);
    res.status(500).json({ message: 'Could not load attendance policy' });
  }
});

router.put('/policy', authenticateToken, async (req, res) => {
  try {
    if ((req.user.role || '').toLowerCase() !== 'owner') return res.status(403).json({ message: 'Only the company owner can update attendance policy' });
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    if (!companyId) return res.status(403).json({ message: 'Missing company affiliation' });
    const input = AttendancePolicy.validatePolicy(req.body?.policy || req.body);
    const current = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const today = AttendancePolicy.localDate(new Date(), current.timezone);
    const outcome = await withAttendanceTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AttendancePolicy.policyLockKey(companyId, today)]);
      const latest = await AttendancePolicy.getCompanyPolicy(companyId, client);
      const hasTodayRecords = await client.query('SELECT id FROM attendance WHERE company_id::text = $1::text AND date = $2 LIMIT 1', [String(companyId), today]);
      if (hasTodayRecords.rows.length && JSON.stringify(input) !== JSON.stringify(latest)) return { conflict: true };
      return { policy: await AttendancePolicy.saveCompanyPolicy(companyId, req.user.userId || req.user.id, input, client) };
    });
    if (outcome.conflict) return res.status(409).json({ message: 'Attendance policy changes are blocked after today’s attendance has started. Save the new policy before the next work date.' });
    const policy = outcome.policy;
    res.json({ success: true, policy });
  } catch (err) {
    const status = /policy|time|timezone|unknown|must|invalid|cutoff|shift|break|grace|rounding/i.test(err.message) ? 400 : 500;
    console.error('❌ Error saving attendance policy:', err);
    res.status(status).json({ message: status === 400 ? err.message : 'Could not save attendance policy' });
  }
});

// ─── EMPLOYEE ENDPOINTS ──────────────────────────────────────────────────────

/**
 * POST /api/attendance/clock-in
 * Employee clocks in for the day (Enterprise: 9 AM shift start)
 */
router.post('/clock-in', authenticateToken, async (req, res) => {
  try {
    if (!requireEmployee(req, res)) return;
    const userId = req.user.userId || req.user.id;
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    const method = 'manual';
    const biometric_device_id = null;
    const clockInTime = new Date();
    const currentPolicy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const today = AttendancePolicy.localDate(clockInTime, currentPolicy.timezone);
    const { record, policy, created } = await withAttendanceTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AttendancePolicy.policyLockKey(companyId, today)]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AttendancePolicy.lockKey(userId, companyId, today)]);
      const member = await client.query('SELECT id FROM users WHERE id = $1 AND company_id::text = $2::text AND role = $3 LIMIT 1', [userId, String(companyId), 'employee']);
      if (!member.rows.length) throw Object.assign(new Error('Employee does not belong to this company'), { statusCode: 403 });
      const companyPolicy = await AttendancePolicy.getCompanyPolicy(companyId, client);
      const existing = await client.query('SELECT * FROM attendance WHERE user_id = $1 AND company_id::text = $2::text AND date = $3 ORDER BY created_at ASC FOR UPDATE', [userId, String(companyId), today]);
      if (existing.rows.length > 1) throw Object.assign(new Error('Multiple attendance records exist for this employee and work date; owner review is required'), { statusCode: 409 });
      if (existing.rows[0]?.check_in_time) return { record: existing.rows[0], policy: companyPolicy, created: false };
      const eligibility = AttendancePolicy.evaluateClockIn(clockInTime, companyPolicy);
      if (!eligibility.allowed) throw Object.assign(new Error(eligibility.reason), { statusCode: 400, code: eligibility.code });
      let result;
      if (existing.rows.length === 1) {
        result = await client.query(`UPDATE attendance SET check_in_time = $1, is_late = $2, status = $3, clock_in_method = $4, biometric_device_id = $5, updated_at = NOW() WHERE id = $6 AND company_id::text = $7::text RETURNING *`, [clockInTime, eligibility.is_late, eligibility.status, method, biometric_device_id || null, existing.rows[0].id, String(companyId)]);
      } else {
        result = await client.query(`INSERT INTO attendance (user_id, company_id, date, check_in_time, is_late, status, clock_in_method, biometric_device_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()) RETURNING *`, [userId, companyId, today, clockInTime, eligibility.is_late, eligibility.status, method, biometric_device_id || null]);
      }
      return { record: result.rows[0], policy: companyPolicy, created: true };
    });
    const isLate = Boolean(record.is_late);
    const isHalfDay = record.status === 'half_day';
    const provisionalStatus = record.status;
    if (!created) return res.json({ ...record, status_label: isHalfDay ? 'Half Day' : isLate ? 'Late' : 'Present' });

    // Build human-readable status label
    const statusLabel = isHalfDay ? 'Half Day' : isLate ? 'Late' : 'Present';
    console.log(`✅ Clock-in recorded for user ${userId} at ${formatPolicyTime(clockInTime, policy.timezone)} — ${statusLabel} (${method})`);

    // Send notification to owners about employee clock-in
    try {
      const userInfo = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
      const employeeName = userInfo.rows[0]?.name || 'Employee';

      await createNotificationForOwners({
        company_id: companyId,
        type: 'employee_clock_in',
        idempotency_key: `attendance_clock_in:${companyId}:${record.id}`,
        title: 'Employee Clocked In',
        message: `${employeeName} clocked in at ${formatPolicyTime(clockInTime, policy.timezone)} (${statusLabel})`,
        priority: isHalfDay ? 'high' : isLate ? 'medium' : 'low',
        data: { employee_id: userId, attendance_id: record.id, is_late: isLate, status: provisionalStatus, url: '/owner/attendance' }
      });

      console.log(`✅ Notified owners about clock-in`);
    } catch (notifErr) {
      console.error('❌ Failed to send clock-in notification to owners:', notifErr);
    }

    // Send late / half-day notification to employee
    if (isHalfDay) {
      try {
        await createNotification({
          user_id: userId,
          company_id: companyId,
          type: 'attendance_half_day',
          title: 'Half Day Recorded',
          message: `You clocked in at ${formatPolicyTime(clockInTime, policy.timezone)} — recorded as Half Day.`,
          priority: 'medium',
          data: { attendance_id: record.id, url: '/employee/attendance' }
        });
      } catch (notifErr) {
        console.error('❌ Failed to send half-day notification:', notifErr);
      }
    } else if (isLate) {
      try {
        await createNotification({
          user_id: userId,
          company_id: companyId,
          type: 'attendance_late',
          title: 'Late Clock-In',
          message: `You clocked in late at ${formatPolicyTime(clockInTime, policy.timezone)}.`,
          priority: 'low',
          data: { attendance_id: record.id, url: '/employee/attendance' }
        });
      } catch (notifErr) {
        console.error('❌ Failed to send late notification:', notifErr);
      }
    }

    // Return record with status label for the frontend
    res.json({ ...record, status_label: statusLabel });
  } catch (err) {
    console.error('❌ Clock-in error:', err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Server error during clock-in', ...(err.code ? { code: err.code } : {}) });
  }
});

/**
 * POST /api/attendance/clock-out
 * Employee clocks out for the day (Enterprise: 7 PM shift end, half-day detection)
 */
router.post('/clock-out', authenticateToken, async (req, res) => {
  try {
    if (!requireEmployee(req, res)) return;
    const userId = req.user.userId || req.user.id;
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    const method = 'manual';
    const biometric_device_id = null;
    const now = new Date();
    const currentPolicy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const today = AttendancePolicy.localDate(now, currentPolicy.timezone);
    const { record: resultRecord, changed } = await withAttendanceTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AttendancePolicy.policyLockKey(companyId, today)]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AttendancePolicy.lockKey(userId, companyId, today)]);
      const policy = await AttendancePolicy.getCompanyPolicy(companyId, client);
      const records = await client.query('SELECT * FROM attendance WHERE user_id = $1 AND company_id::text = $2::text AND date = $3 ORDER BY created_at ASC FOR UPDATE', [userId, String(companyId), today]);
      if (records.rows.length > 1) throw Object.assign(new Error('Multiple attendance records exist for this employee and work date; owner review is required'), { statusCode: 409 });
      const existing = records.rows[0];
      if (!existing?.check_in_time) throw Object.assign(new Error('Please clock in first'), { statusCode: 400 });
      if (existing.check_out_time) return { record: existing, changed: false };
      const { cutoff, due: automatic } = AttendancePolicy.automaticClockOutFor(today, now, policy);
      const clockOutTime = automatic ? cutoff : now;
      const workingHours = AttendancePolicy.calculateWorkingHours(existing.check_in_time, clockOutTime, policy);
      const status = AttendancePolicy.classifyStatus(existing.check_in_time, clockOutTime, policy);
      const updated = await client.query(`UPDATE attendance SET check_out_time = $1, working_hours = $2, status = $3, clock_out_method = $4, is_auto_clocked_out = $5, biometric_device_id = COALESCE($6, biometric_device_id), updated_at = NOW() WHERE id = $7 AND company_id::text = $8::text AND check_out_time IS NULL RETURNING *`, [clockOutTime, workingHours, status, automatic ? 'automatic' : method, automatic, biometric_device_id || null, existing.id, String(companyId)]);
      return { record: updated.rows[0] || existing, changed: Boolean(updated.rows[0]) };
    });
    if (!changed) return res.json(resultRecord);
    const workingHours = Number(resultRecord.working_hours || 0);
    const status = resultRecord.status;

    console.log(`✅ Clock-out recorded for user ${userId}. Hours: ${workingHours}, Status: ${status} (${method})`);

    // Send notification to owners about employee clock-out
    try {
      // Get employee name
      const userInfo = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
      const employeeName = userInfo.rows[0]?.name || 'Employee';

      await createNotificationForOwners({
        company_id: companyId,
        type: 'employee_clock_out',
        idempotency_key: `attendance_clock_out:${companyId}:${resultRecord.id}`,
        title: 'Employee Clocked Out',
        message: `${employeeName} clocked out. Hours: ${workingHours.toFixed(2)}, Status: ${status}`,
        priority: 'low',
        data: { employee_id: userId, attendance_id: resultRecord.id, working_hours: workingHours, status, url: '/owner/attendance' }
      });

      console.log(`✅ Notified owners about clock-out`);
    } catch (notifErr) {
      console.error('❌ Failed to send clock-out notification to owners:', notifErr);
    }

    res.json(resultRecord);
  } catch (err) {
    console.error('❌ Clock-out error:', err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Server error during clock-out' });
  }
});

/**
 * GET /api/attendance/me
 * Get current employee's open attendance record, history, and stats
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    if (!companyId) return res.status(403).json({ message: 'Missing company affiliation' });
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const today = AttendancePolicy.localDate(new Date(), policy.timezone);

    // Fetch today's record
    const todayRes = await pool.query(
      `SELECT * FROM attendance WHERE user_id = $1 AND company_id::text = $2::text AND date = $3 ORDER BY created_at ASC LIMIT 2`,
      [userId, String(companyId), today]
    );
    if (todayRes.rows.length > 1) return res.status(409).json({ message: 'Multiple attendance records exist for today; Owner review is required' });

    // Fetch last 60 days history
    const historyRes = await pool.query(
      `SELECT * FROM attendance WHERE user_id = $1 AND company_id::text = $2::text ORDER BY date DESC LIMIT 60`,
      [userId, String(companyId)]
    );

    let openRecord = null;
    let todayRecord = null;

    if (todayRes.rows.length > 0) {
      const row = todayRes.rows[0];
      todayRecord = row;
      if (row.check_in_time && !row.check_out_time) {
        const inTimeStr = AttendancePolicy.localTime(row.check_in_time, policy.timezone);
        openRecord = {
          id: row.id,
          date: row.date ? String(row.date).slice(0, 10) : today,
          clockIn: inTimeStr,
          clock_in: row.check_in_time,
          clockOut: null,
          clock_out: null,
          status: row.status || 'present',
          is_auto_clocked_out: Boolean(row.is_auto_clocked_out),
        };
      }
    }

    const records = historyRes.rows.map((r) => {
      const inTime = r.check_in_time ? new Date(r.check_in_time) : null;
      const outTime = r.check_out_time ? new Date(r.check_out_time) : null;
      let hoursWorked = Number(r.working_hours) || 0;
      if (!r.working_hours && inTime && outTime) hoursWorked = AttendancePolicy.calculateWorkingHours(inTime, outTime, policy);
      return {
        id: r.id,
        date: r.date ? String(r.date).slice(0, 10) : today,
        clockIn: inTime ? AttendancePolicy.localTime(inTime, policy.timezone) : null,
        clockOut: outTime ? AttendancePolicy.localTime(outTime, policy.timezone) : null,
        hoursWorked,
        status: r.status || 'present',
        is_late: Boolean(r.is_late),
        is_auto_clocked_out: Boolean(r.is_auto_clocked_out),
        notes: r.notes || ''
      };
    });

    const [currentYear, currentMonth] = today.split('-').map(Number);
    const monthRecords = records.filter((r) => {
      return r.date?.startsWith(`${currentYear}-${String(currentMonth).padStart(2, '0')}-`);
    });

    const daysPresent = monthRecords.filter((r) => r.status === 'present' || r.status === 'late').length;
    const lateCount = monthRecords.filter((r) => r.is_late || r.status === 'late').length;
    const halfDayCount = monthRecords.filter((r) => r.status === 'half_day').length;
    const totalHours = Math.round(monthRecords.reduce((sum, r) => sum + r.hoursWorked, 0) * 100) / 100;

    res.json({
      success: true,
      openRecord,
      today: todayRecord,
      records,
      policy: { timezone: policy.timezone },
      stats: {
        daysPresent,
        totalHours,
        lateCount,
        halfDayCount
      }
    });
  } catch (err) {
    console.error('❌ Error in GET /api/attendance/me:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

/**
 * GET /api/attendance/today
 * Get today's attendance status for employee
 */
router.get('/today', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    if (!companyId) return res.status(403).json({ message: 'Missing company affiliation' });
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const todayIST = AttendancePolicy.localDate(new Date(), policy.timezone);

    const result = await pool.query(
      `SELECT * FROM attendance 
       WHERE user_id = $1 AND company_id::text = $2::text AND date = $3
       ORDER BY date DESC, check_in_time DESC LIMIT 2`,
      [userId, String(companyId), todayIST]
    );

    if (result.rows.length > 1) return res.status(409).json({ message: 'Multiple attendance records exist for today; Owner review is required' });

    if (result.rows.length === 0) {
      return res.json({
        date: todayIST,
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
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    const { month, year } = req.query;
    if (!companyId) return res.status(403).json({ message: 'Missing company affiliation' });

    let query = 'SELECT * FROM attendance WHERE user_id = $1 AND company_id::text = $2::text';
    const params = [userId, String(companyId)];

    if (month && year) {
      query += ' AND EXTRACT(MONTH FROM date) = $3 AND EXTRACT(YEAR FROM date) = $4';
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
    if (!requireEmployee(req, res)) return;
    const userId = req.user.userId || req.user.id;
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    const { attendance_id, requested_check_in, requested_check_out, reason } = req.body;

    if (!attendance_id || !reason) {
      return res.status(400).json({ message: 'attendance_id and reason are required' });
    }

    // Verify attendance belongs to user
    const attendance = await pool.query(
      'SELECT * FROM attendance WHERE id = $1 AND user_id = $2 AND company_id::text = $3::text',
      [attendance_id, userId, String(companyId)]
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
      await createNotificationForOwners({
        company_id: companyId,
        type: 'attendance_correction_request',
        idempotency_key: `attendance_correction:${companyId}:${result.rows[0].id}`,
        title: 'Attendance Correction Request',
        message: `Employee has requested attendance correction`,
        priority: 'medium',
        data: { correction_id: result.rows[0].id, user_id: userId, url: '/owner/attendance' }
      });
      console.log(`✅ Notified owners about correction request`);
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
    if (req.user.role !== 'owner' && req.user.role !== 'admin' && req.user.role !== 'hr') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    if (!companyId) return res.status(403).json({ message: 'Missing company affiliation' });
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const today = AttendancePolicy.localDate(new Date(), policy.timezone);

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
                a.is_auto_clocked_out,
                (lv.user_id IS NOT NULL) AS on_leave
             FROM users u
             LEFT JOIN attendance a ON u.id = a.user_id AND a.company_id::text = u.company_id::text AND a.date = $1
             LEFT JOIN LATERAL (
               SELECT lr.user_id FROM hr_employee_requests lr
               WHERE lr.user_id::text = u.id::text AND lr.company_id::text = u.company_id::text
                 AND lr.request_type = 'leave' AND lr.status = 'approved'
                 AND COALESCE(lr.details->>'start_date', lr.details->>'from_date') <= $1::text
                 AND COALESCE(lr.details->>'end_date', lr.details->>'to_date') >= $1::text
               LIMIT 1
             ) lv ON TRUE
             WHERE u.role = 'employee' AND u.company_id = $2
             ORDER BY u.name ASC`,
      [today, companyId]
    );

    // Calculate summary
    const summary = {
      total: result.rows.length,
      present: result.rows.filter(r => r.check_in_time).length,
      absent: result.rows.filter(r => !r.check_in_time && !r.on_leave).length,
      late: result.rows.filter(r => r.is_late).length,
      on_leave: result.rows.filter(r => r.on_leave).length,
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
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);

    // Verify the requested employee belongs to this owner's company
    const empCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND company_id = $2',
      [userId, companyId]
    );
    if (empCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Employee not found in your company' });
    }

    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const [localYear, localMonth] = AttendancePolicy.localDate(new Date(), policy.timezone).split('-').map(Number);
    const currentMonth = month || localMonth;
    const currentYear = year || localYear;

    // Get attendance records
    const records = await pool.query(
      `SELECT * FROM attendance 
             WHERE user_id = $1 AND company_id::text = $4::text
               AND EXTRACT(MONTH FROM date) = $2 
               AND EXTRACT(YEAR FROM date) = $3
             ORDER BY date DESC`,
      [userId, currentMonth, currentYear, String(companyId)]
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
    const companyId = req.user.companyId;

    // Verify the requested employee belongs to this owner's company
    const empCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND company_id = $2',
      [userId, companyId]
    );
    if (empCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Employee not found in your company' });
    }

    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const [localYear, localMonth] = AttendancePolicy.localDate(new Date(), policy.timezone).split('-').map(Number);
    const currentMonth = month || localMonth;
    const currentYear = year || localYear;

    const records = await pool.query(
      `SELECT date, check_in_time, check_out_time, working_hours, status, is_late, is_auto_clocked_out
             FROM attendance 
             WHERE user_id = $1 AND company_id::text = $4::text
               AND EXTRACT(MONTH FROM date) = $2 
               AND EXTRACT(YEAR FROM date) = $3
             ORDER BY date ASC`,
      [userId, currentMonth, currentYear, String(companyId)]
    );

    res.json(records.rows);
  } catch (err) {
    console.error('❌ Error fetching calendar data:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * PATCH /api/attendance/corrections/:id/approve
 * Approve correction request (Owner only)
 * ⚠️  Must come BEFORE PATCH /:id or Express will match 'corrections' as the :id param
 */
router.patch('/corrections/:id/approve', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { id } = req.params;
    const reviewedBy = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    if (!companyId) {
      return res.status(403).json({ message: 'Missing company affiliation' });
    }

    let correctionData;
    let reviewedCorrection;
    try {
      ({ correctionData, reviewedCorrection } = await withAttendanceTransaction(async (client) => {
        const correction = await client.query(
          `SELECT ac.*, a.company_id, a.is_processed
           FROM attendance_corrections ac JOIN attendance a ON ac.attendance_id = a.id
           WHERE ac.id = $1 AND a.company_id::text = $2::text FOR UPDATE OF ac, a`,
          [id, String(companyId)]
        );
        if (!correction.rows.length) throw Object.assign(new Error('Correction request not found'), { statusCode: 404 });
        const row = correction.rows[0];
        if (row.status !== 'pending') throw Object.assign(new Error('Correction request has already been reviewed'), { statusCode: 409 });
        if (row.is_processed) throw Object.assign(new Error('Cannot approve a correction for processed attendance'), { statusCode: 403 });
        const policy = await AttendancePolicy.getCompanyPolicy(companyId, client);
        const workingHours = AttendancePolicy.calculateWorkingHours(row.requested_check_in, row.requested_check_out, policy);
        const status = AttendancePolicy.classifyStatus(row.requested_check_in, row.requested_check_out, policy);
        const late = AttendancePolicy.isLate(row.requested_check_in, policy);
        const attendanceUpdate = await client.query(
          `UPDATE attendance SET check_in_time = $1, check_out_time = $2, working_hours = $3, status = $4, is_late = $5, is_manual = TRUE, edited_by = $6, updated_at = NOW()
           WHERE id = $7 AND company_id::text = $8::text AND is_processed = FALSE RETURNING id`,
          [row.requested_check_in, row.requested_check_out, workingHours, status, late, reviewedBy, row.attendance_id, String(companyId)]
        );
        if (!attendanceUpdate.rows.length) throw Object.assign(new Error('Attendance was processed while the correction was pending'), { statusCode: 403 });
        const result = await client.query(
          `UPDATE attendance_corrections SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
           WHERE id = $2 AND status = 'pending' RETURNING *`,
          [reviewedBy, id]
        );
        if (!result.rows.length) throw Object.assign(new Error('Correction request has already been reviewed'), { statusCode: 409 });
        return { correctionData: row, reviewedCorrection: result.rows[0] };
      }));
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
      throw error;
    }
    const result = { rows: [reviewedCorrection] };

    // Notify employee
    try {
      await createNotification({
        user_id: correctionData.user_id,
        company_id: companyId,
        type: 'attendance_correction_approved',
        title: 'Attendance Correction Approved',
        message: 'Your attendance correction request has been approved',
        priority: 'medium',
        data: { correction_id: id, url: '/employee/attendance' }
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
 * ⚠️  Must come BEFORE PATCH /:id
 */
router.patch('/corrections/:id/reject', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { id } = req.params;
    const { rejection_reason } = req.body;
    const reviewedBy = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    if (!companyId) {
      return res.status(403).json({ message: 'Missing company affiliation' });
    }

    // Get correction request and verify company ownership
    const correction = await pool.query(
      `SELECT ac.*, a.company_id 
       FROM attendance_corrections ac 
       JOIN attendance a ON ac.attendance_id = a.id 
       WHERE ac.id = $1 AND a.company_id = $2`,
      [id, companyId]
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
        data: { correction_id: id, url: '/employee/attendance' }
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
 * PATCH /api/attendance/:id
 * Manually edit attendance record (Owner only)
 * ⚠️  Must come AFTER all named sub-routes like /corrections/:id/*
 */
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { id } = req.params;
    const { check_in_time, check_out_time, notes } = req.body;
    const editedBy = req.user.userId || req.user.id;

    const companyId = req.user.companyId;
    if (!companyId) {
      return res.status(403).json({ message: 'Missing company affiliation' });
    }

    // Check if record is processed (locked) and verify company_id
    const existing = await pool.query('SELECT is_processed, company_id, check_in_time, check_out_time FROM attendance WHERE id = $1 AND company_id = $2', [id, companyId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ message: 'Attendance record not found or access denied' });
    }
    if (existing.rows[0].is_processed) {
      return res.status(403).json({ message: 'Cannot edit processed records' });
    }

    // Calculate working hours and status through the same company policy used by punches.
    let workingHours = null;
    const nextIn = check_in_time || existing.rows[0].check_in_time;
    const nextOut = check_out_time || existing.rows[0].check_out_time;
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    if (nextIn && nextOut) workingHours = AttendancePolicy.calculateWorkingHours(nextIn, nextOut, policy);
    const canonicalStatus = AttendancePolicy.classifyStatus(nextIn, nextOut, policy);
    const canonicalLate = nextIn ? AttendancePolicy.isLate(nextIn, policy) : false;

    const result = await pool.query(
      `UPDATE attendance 
             SET check_in_time = COALESCE($1, check_in_time),
                 check_out_time = COALESCE($2, check_out_time),
                working_hours = CASE WHEN $1 IS NULL THEN NULL WHEN $2 IS NULL THEN NULL ELSE $3 END,
                 status = $4,
                 notes = COALESCE($5, notes),
                 is_manual = TRUE,
                 edited_by = $6,
                  is_late = $9,
                  updated_at = NOW()
             WHERE id = $7 AND company_id = $8 AND is_processed = FALSE
             RETURNING *`,
      [check_in_time, check_out_time, workingHours, canonicalStatus, notes, editedBy, id, companyId, canonicalLate]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ message: 'Attendance was processed before the edit could be saved' });
    }

    console.log(`✅ Attendance ${id} manually edited by owner`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error editing attendance:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * GET /api/attendance/report
 * Generate attendance report (Owner only)
 */
router.get('/report', authenticateToken, loadPlan, requireFeature('basic_reports', 'basic reports'), async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { month, year, employee_id } = req.query;
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    if (!companyId) return res.status(403).json({ message: 'Missing company affiliation' });
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const [localYear, localMonth] = AttendancePolicy.localDate(new Date(), policy.timezone).split('-').map(Number);
    const currentMonth = month || localMonth;
    const currentYear = year || localYear;

    let query = `
            SELECT 
                u.id as user_id,
                u.name as employee_name,
                u.email as employee_email,
                a.*
            FROM users u
      LEFT JOIN attendance a ON u.id::text = a.user_id::text AND u.company_id::text = a.company_id::text
            WHERE u.role = 'employee'
              AND u.company_id = $3
              AND EXTRACT(MONTH FROM a.date) = $1
              AND EXTRACT(YEAR FROM a.date) = $2
        `;

    const params = [currentMonth, currentYear, companyId];

    if (employee_id) {
      query += ' AND u.id = $4';
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
    if (!['owner', 'admin'].includes((req.user.role || '').toLowerCase())) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const companyId = safeCompanyId(req.user.companyId || req.user.company_id);
    if (!companyId) return res.status(403).json({ message: 'Missing company affiliation' });
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const today = AttendancePolicy.localDate(new Date(), policy.timezone);
    const targetDate = req.body?.date || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || targetDate > today) return res.status(400).json({ message: 'A valid company-local date no later than today is required' });
    const yesterdayInstant = new Date(AttendancePolicy.zonedDateTimeToUtc(today, '12:00', policy.timezone).getTime() - 86400000);
    const yesterday = AttendancePolicy.localDate(yesterdayInstant, policy.timezone);
    if (targetDate !== today && targetDate !== yesterday) return res.status(400).json({ message: 'Manual processing is limited to today and yesterday for scheduler recovery' });
    const result = await withAttendanceTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`attendance-run:${companyId}:${targetDate}`]);
      return AttendancePolicy.processCompanyDate(companyId, targetDate, client, new Date());
    });

    res.json({
      success: true,
      date: targetDate,
      auto_clocked_out: result.auto_clocked_out,
      marked_absent: result.marked_absent,
      records_locked: result.records_locked,
      due: result.due,
    });
  } catch (err) {
    console.error('❌ Daily processing error:', err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Server error during daily processing' });
  }
});

// ─── BIOMETRIC INTEGRATION ENDPOINTS ─────────────────────────────────────────

/**
 * POST /api/attendance/biometric/webhook
 * Webhook for biometric devices to send attendance data
 */
router.post('/biometric/webhook', async (req, res) => {
  try {
    if (!BiometricWebhookAuth.isWebhookEnabled(process.env.BIOMETRIC_WEBHOOK_ENABLED, process.env.BIOMETRIC_GATEWAY_CONTRACT_VERIFIED)) {
      return res.status(503).json({ message: 'Biometric webhook integration is disabled pending gateway contract verification' });
    }
    const secret = process.env.BIOMETRIC_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ message: 'Biometric webhook authentication is not configured' });
    if (!redisClient || redisClient.status !== 'ready') return res.status(503).json({ message: 'Biometric replay protection is unavailable' });
    const verified = BiometricWebhookAuth.verifyBiometricSignature({
      secret,
      signature: req.get('x-device-signature'),
      signedAt: req.get('x-device-timestamp'),
      nonce: req.get('x-device-nonce'),
      body: req.body,
    });
    if (!verified.valid) return res.status(401).json({ message: verified.reason === 'expired' ? 'Biometric signature timestamp expired' : 'Invalid biometric signature headers' });
    const nonceResult = await BiometricWebhookAuth.claimNonce(redisClient, verified.nonce);
    if (nonceResult === 'unavailable') return res.status(503).json({ message: 'Biometric replay protection is unavailable' });
    if (nonceResult === 'replayed') return res.status(409).json({ message: 'Biometric request replay detected' });

    const { device_id, employee_id, action, timestamp } = req.body;

    if (!device_id || !employee_id || !action) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    return await storage.run({ isWebRequest: false, bypassRls: true, role: 'system' }, async () => {
    const device = await pool.query('SELECT * FROM biometric_devices WHERE device_id = $1 AND is_active = TRUE', [device_id]);

    if (device.rows.length === 0) {
      return res.status(404).json({ message: 'Device not registered or inactive' });
    }

    // Verify employee exists and belongs to the same company as the device
    const employee = await pool.query(
      "SELECT id, company_id FROM users WHERE id = $1 AND role = 'employee'",
      [employee_id]
    );

    if (employee.rows.length === 0) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Ensure the employee belongs to the same company as the biometric device
    if (String(employee.rows[0].company_id) !== String(device.rows[0].company_id)) {
      return res.status(403).json({ message: 'Device and employee company mismatch' });
    }

    const actionTime = new Date(timestamp || Date.now());
    if (!Number.isFinite(actionTime.getTime()) || Math.abs(Date.now() - actionTime.getTime()) > 5 * 60 * 1000) return res.status(400).json({ message: 'Biometric event timestamp is outside the accepted window' });
    const companyId = employee.rows[0].company_id;
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const today = AttendancePolicy.localDate(actionTime, policy.timezone);

    if (action === 'clock_in') {
      const result = await withAttendanceTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AttendancePolicy.policyLockKey(companyId, today)]);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AttendancePolicy.lockKey(employee_id, companyId, today)]);
        const currentPolicy = await AttendancePolicy.getCompanyPolicy(companyId, client);
        const eligibility = AttendancePolicy.evaluateClockIn(actionTime, currentPolicy);
        if (!eligibility.allowed) throw Object.assign(new Error(eligibility.reason), { statusCode: 400, code: eligibility.code });
        const existing = await client.query('SELECT * FROM attendance WHERE user_id = $1 AND company_id::text = $2::text AND date = $3 ORDER BY created_at ASC FOR UPDATE', [employee_id, String(companyId), today]);
        if (existing.rows.length > 1) throw new Error('Duplicate attendance rows require owner review');
        if (existing.rows[0]?.check_in_time) return existing.rows[0];
        if (existing.rows.length === 1) return (await client.query("UPDATE attendance SET check_in_time = $1, is_late = $2, status = $3, clock_in_method = 'biometric', biometric_device_id = $4, updated_at = NOW() WHERE id = $5 RETURNING *", [actionTime, eligibility.is_late, eligibility.status, device_id, existing.rows[0].id])).rows[0];
        return (await client.query("INSERT INTO attendance (user_id, company_id, date, check_in_time, is_late, status, clock_in_method, biometric_device_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,'biometric',$7,NOW(),NOW()) RETURNING *", [employee_id, companyId, today, actionTime, eligibility.is_late, eligibility.status, device_id])).rows[0];
      });
      return res.json({ success: true, attendance: result });
    }

    if (action === 'clock_out') {
      const record = await withAttendanceTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AttendancePolicy.policyLockKey(companyId, today)]);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AttendancePolicy.lockKey(employee_id, companyId, today)]);
        const existing = await client.query('SELECT * FROM attendance WHERE user_id = $1 AND company_id::text = $2::text AND date = $3 ORDER BY created_at ASC FOR UPDATE', [employee_id, String(companyId), today]);
        if (!existing.rows.length || !existing.rows[0].check_in_time) throw Object.assign(new Error('No clock-in record found'), { statusCode: 400 });
        if (existing.rows.length > 1) throw Object.assign(new Error('Duplicate attendance rows require owner review'), { statusCode: 409 });
        if (existing.rows[0].check_out_time) return existing.rows[0];
        const currentPolicy = await AttendancePolicy.getCompanyPolicy(companyId, client);
        const { cutoff, due: automatic } = AttendancePolicy.automaticClockOutFor(today, actionTime, currentPolicy);
        const effectiveOut = automatic ? cutoff : actionTime;
        const workingHours = AttendancePolicy.calculateWorkingHours(existing.rows[0].check_in_time, effectiveOut, currentPolicy);
        const status = AttendancePolicy.classifyStatus(existing.rows[0].check_in_time, effectiveOut, currentPolicy);
        const updated = await client.query(`UPDATE attendance SET check_out_time = $1, working_hours = $2, status = $3, clock_out_method = 'biometric', is_auto_clocked_out = $4, biometric_device_id = $5, updated_at = NOW() WHERE id = $6 AND company_id::text = $7::text AND check_out_time IS NULL RETURNING *`, [effectiveOut, workingHours, status, automatic, device_id, existing.rows[0].id, String(companyId)]);
        return updated.rows[0] || existing.rows[0];
      });
      console.log(`✅ Biometric clock-out: ${employee_id} via ${device_id}`);
      return res.json({ success: true, attendance: record });
    }

    res.status(400).json({ message: 'Invalid action' });
    });
  } catch (err) {
    console.error('❌ Biometric webhook error:', err.message);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Server error' });
  }
});

module.exports = router;
