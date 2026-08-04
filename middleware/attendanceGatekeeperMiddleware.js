const { pool } = require('../db');

/**
 * Enterprise Attendance & Clock-In Gatekeeper Middleware
 * Validates that an employee has an active clock-in shift today before allowing field operations.
 * Bypasses Owners, Admins, Superadmins, and HR roles automatically.
 */
async function requireClockIn(req, res, next) {
  try {
    const userRole = (req.user?.role || 'employee').toLowerCase();
    
    // Bypass Gatekeeper for Owner, Admin, Superadmin, and HR management
    if (['owner', 'admin', 'superadmin', 'hr', 'manager'].includes(userRole)) {
      return next();
    }

    const userId = req.user?.id || req.user?.userId;
    const companyId = req.user?.companyId || req.user?.company_id || 1;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Check if employee has an active clock-in record for TODAY
    const shiftRes = await pool.query(
      `SELECT id, clock_in, clock_out FROM attendance
       WHERE user_id::text = $1::text 
         AND (company_id::text = $2::text OR company_id IS NULL OR $2::text = '1')
         AND date = CURRENT_DATE
         AND clock_in IS NOT NULL 
         AND clock_out IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [String(userId), String(companyId)]
    );

    if (shiftRes.rows.length > 0) {
      // Employee is clocked in with active shift — allow operation
      return next();
    }

    // Block Operation — Log Audit Trail asynchronously
    const attemptedOperation = req.originalUrl || req.path || 'Operational Action';
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    pool.query(
      `INSERT INTO workforce_gatekeeper_audit_logs 
       (company_id, user_id, user_name, role, job_id, attempted_operation, restriction_code, restriction_reason, ip_address, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'SHIFT_NOT_STARTED', 'Employee attempted operational action before starting today shift', $7, $8, NOW())`,
      [
        String(companyId),
        String(userId),
        req.user?.name || req.user?.email || 'Employee',
        userRole,
        req.params?.id || req.params?.jobId || req.body?.job_id || null,
        attemptedOperation,
        clientIp,
        userAgent
      ]
    ).catch((logErr) => console.warn('⚠️ Gatekeeper log warning:', logErr.message));

    return res.status(403).json({
      success: false,
      code: 'SHIFT_NOT_STARTED',
      message: 'You must clock in before performing company operations.'
    });

  } catch (err) {
    console.error('❌ Attendance Gatekeeper Middleware Error:', err.message);
    // On unexpected DB error, fail-safe block to preserve shift integrity
    return res.status(403).json({
      success: false,
      code: 'SHIFT_NOT_STARTED',
      message: 'You must clock in before performing company operations.'
    });
  }
}

module.exports = { requireClockIn };
