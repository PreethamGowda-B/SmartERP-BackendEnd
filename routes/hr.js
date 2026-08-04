const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification } = require('../utils/notificationHelpers');
const EventMessagingService = require('../services/eventMessagingService');

// ── HR Audit Logging Helper ──────────────────────────────────────────────────
async function logHrAudit({ companyId, performedBy, performedByName, action, targetEmployeeId, targetEmployeeName, oldValue, newValue, reason, req }) {
  try {
    const ip = req?.headers['x-forwarded-for'] || req?.socket?.remoteAddress || '127.0.0.1';
    const device = req?.headers['user-agent'] || 'Unknown Device';
    await pool.query(
      `INSERT INTO hr_audit_logs 
       (company_id, performed_by, performed_by_name, action, target_employee_id, target_employee_name, old_value, new_value, reason, ip_address, device_info)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        companyId,
        String(performedBy),
        performedByName || 'HR Manager',
        action,
        targetEmployeeId ? String(targetEmployeeId) : null,
        targetEmployeeName || null,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        reason || null,
        ip,
        device
      ]
    );
  } catch (err) {
    console.error('⚠️ Error logging HR audit trail:', err.message);
  }
}

// ── 1. GET /api/hr/analytics — Master HR Executive Dashboard Metrics ─────────
router.get('/analytics', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;

    const headcountRes = await pool.query(`SELECT COUNT(*) as total FROM users WHERE company_id = $1 AND is_active = true`, [companyId]);
    const presentRes = await pool.query(`SELECT COUNT(DISTINCT user_id) as count FROM attendance WHERE company_id = $1 AND date = CURRENT_DATE AND status IN ('present', 'arrived')`, [companyId]);
    const lateRes = await pool.query(`SELECT COUNT(DISTINCT user_id) as count FROM attendance WHERE company_id = $1 AND date = CURRENT_DATE AND is_late = true`, [companyId]);
    const pendingReqRes = await pool.query(`SELECT COUNT(*) as count FROM hr_employee_requests WHERE company_id = $1 AND status = 'pending'`, [companyId]);
    const recruitmentRes = await pool.query(`SELECT COUNT(*) as count FROM hr_recruitment_candidates WHERE company_id = $1 AND stage NOT IN ('joined', 'rejected')`, [companyId]);
    const assetRes = await pool.query(`SELECT COUNT(*) as count FROM hr_assets WHERE company_id = $1 AND return_status = 'assigned'`, [companyId]);

    res.json({
      success: true,
      analytics: {
        totalHeadcount: parseInt(headcountRes.rows[0]?.total || 0),
        presentToday: parseInt(presentRes.rows[0]?.count || 0),
        lateToday: parseInt(lateRes.rows[0]?.count || 0),
        pendingRequests: parseInt(pendingReqRes.rows[0]?.count || 0),
        activeRecruitment: parseInt(recruitmentRes.rows[0]?.count || 0),
        assignedAssets: parseInt(assetRes.rows[0]?.count || 0),
      }
    });
  } catch (err) {
    console.error('Error fetching HR analytics:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── 2. GET & POST /api/hr/requests — Unified Employee Request Processing ───
router.get('/requests', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status = 'all' } = req.query;

    let query = `SELECT * FROM hr_employee_requests WHERE company_id = $1`;
    let params = [companyId];

    if (status !== 'all') {
      query += ` AND status = $2`;
      params.push(status);
    }
    query += ` ORDER BY created_at DESC LIMIT 100`;

    const result = await pool.query(query, params);
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    console.error('Error fetching HR requests:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/requests', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const userId = req.user.userId || req.user.id;
    const userName = req.user.name || 'Employee';
    const { request_type, details } = req.body;

    if (!request_type || !details) {
      return res.status(400).json({ message: 'request_type and details are required' });
    }

    const result = await pool.query(
      `INSERT INTO hr_employee_requests (company_id, user_id, employee_name, request_type, details)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [companyId, userId, userName, request_type, JSON.stringify(details)]
    );

    await logHrAudit({
      companyId,
      performedBy: userId,
      performedByName: userName,
      action: `SUBMIT_${request_type.toUpperCase()}_REQUEST`,
      targetEmployeeId: userId,
      targetEmployeeName: userName,
      newValue: details,
      reason: details.reason || 'Submitted via Employee Portal ESS',
      req
    });

    // Auto-post leave ERP card to employee↔HR conversation
    if (request_type === 'leave') {
      EventMessagingService.onLeaveRequestSubmitted({
        companyId,
        employeeId: userId,
        employeeName: userName,
        leaveType: details.leave_type || 'Leave',
        fromDate: details.from_date || details.date || 'TBD',
        toDate: details.to_date || details.date || 'TBD',
        requestId: result.rows[0].id,
      }).catch(() => {});
    }

    // Real-time Notification to HR / Owner
    try {
      const isLeave = request_type === 'leave';
      const isAttendance = request_type === 'attendance_correction';
      const notifTitle = isLeave ? 'New Leave Request' : isAttendance ? 'Attendance Correction Request' : 'New Employee Request';
      const notifMsg = `${userName} submitted a ${request_type.replace('_', ' ')} request (${details.leave_type || details.reason || 'Pending review'}).`;
      await createNotificationForOwners({
        company_id: companyId,
        type: request_type,
        title: notifTitle,
        message: notifMsg,
        priority: 'medium',
        actor_id: userId,
        data: { request_id: result.rows[0].id, url: '/hr/requests' }
      });
    } catch (nErr) {
      console.warn('⚠️ HR submit notification warning:', nErr.message);
    }

    res.status(201).json({ success: true, request: result.rows[0] });
  } catch (err) {
    console.error('Error creating employee request:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/requests/:id/review', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, hr_comments } = req.body;
    const companyId = req.user.companyId;
    const reviewerId = req.user.userId || req.user.id;
    const reviewerName = req.user.name || 'HR Manager';

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const reqRes = await pool.query(`SELECT * FROM hr_employee_requests WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (reqRes.rows.length === 0) return res.status(404).json({ message: 'Request not found' });

    const empReq = reqRes.rows[0];

    const result = await pool.query(
      `UPDATE hr_employee_requests 
       SET status = $1, hr_comments = $2, reviewed_by = $3, reviewed_at = NOW()
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [status, hr_comments || null, reviewerName, id, companyId]
    );

    // Dynamic Downstream Logic Based on Request Type
    if (status === 'approved') {
      if (empReq.request_type === 'attendance_correction') {
        const det = empReq.details || {};
        if (det.date) {
          await pool.query(
            `UPDATE attendance SET status = 'present', is_late = false, updated_at = NOW()
             WHERE user_id = $1 AND company_id = $2 AND date = $3`,
            [empReq.user_id, companyId, det.date]
          );
        }
      }
    }

    await logHrAudit({
      companyId,
      performedBy: reviewerId,
      performedByName: reviewerName,
      action: `${status.toUpperCase()}_${empReq.request_type.toUpperCase()}_REQUEST`,
      targetEmployeeId: empReq.user_id,
      targetEmployeeName: empReq.employee_name,
      oldValue: { status: empReq.status },
      newValue: { status, hr_comments },
      reason: hr_comments || 'HR Manager review decision',
      req
    });

    // Auto-post HR decision to employee↔HR conversation
    if (empReq.request_type === 'leave') {
      EventMessagingService.onLeaveDecision({
        companyId,
        employeeId: empReq.user_id,
        hrId: reviewerId,
        hrName: reviewerName,
        requestId: id,
        status,
        leaveType: (empReq.details?.leave_type) || 'Leave',
        comments: hr_comments || '',
      }).catch(() => {});
    }

    // Real-time Live Popup Notification to Employee
    try {
      await createNotification({
        user_id: empReq.user_id,
        company_id: companyId,
        type: `${empReq.request_type}_decision`,
        title: `Request ${status.toUpperCase()}`,
        message: `Your ${empReq.request_type.replace('_', ' ')} request has been ${status} by ${reviewerName}.`,
        priority: 'high',
        actor_id: reviewerId,
        data: { request_id: id, url: '/employee/notifications' }
      });
    } catch (nErr) {
      console.warn('⚠️ HR review notification warning:', nErr.message);
    }

    res.json({ success: true, request: result.rows[0] });
  } catch (err) {
    console.error('Error reviewing HR request:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── 3. GET & POST /api/hr/recruitment — ATS Candidates & Offer Letters ──────
router.get('/recruitment', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const result = await pool.query(`SELECT * FROM hr_recruitment_candidates WHERE company_id = $1 ORDER BY created_at DESC`, [companyId]);
    res.json({ success: true, candidates: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/recruitment', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { name, email, phone, designation, department, stage = 'sourced', interview_rating = 0.0 } = req.body;

    const result = await pool.query(
      `INSERT INTO hr_recruitment_candidates (company_id, name, email, phone, designation, department, stage, interview_rating)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [companyId, name, email, phone, designation, department, stage, interview_rating]
    );

    res.status(201).json({ success: true, candidate: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── 4. GET & POST /api/hr/skills — Skill Matrix & Certifications ─────────────
router.get('/skills', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const result = await pool.query(
      `SELECT s.*, u.name as employee_name, u.email as employee_email 
       FROM hr_skills_certifications s 
       JOIN users u ON s.user_id::text = u.id::text 
       WHERE s.company_id = $1 ORDER BY s.created_at DESC`,
      [companyId]
    );
    res.json({ success: true, skills: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/skills', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { user_id, skill_name, certification_name, issuing_authority, expiry_date } = req.body;

    const result = await pool.query(
      `INSERT INTO hr_skills_certifications (company_id, user_id, skill_name, certification_name, issuing_authority, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [companyId, user_id, skill_name, certification_name, issuing_authority, expiry_date || null]
    );

    res.status(201).json({ success: true, skill: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── 5. GET & POST /api/hr/assets — IT & Field Hardware Inventory ────────────
router.get('/assets', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const result = await pool.query(
      `SELECT a.*, u.name as assigned_employee_name 
       FROM hr_assets a 
       LEFT JOIN users u ON a.assigned_to::text = u.id::text 
       WHERE a.company_id = $1 ORDER BY a.created_at DESC`,
      [companyId]
    );
    res.json({ success: true, assets: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/assets', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { asset_name, asset_tag, category, assigned_to, condition = 'good' } = req.body;

    const result = await pool.query(
      `INSERT INTO hr_assets (company_id, asset_name, asset_tag, category, assigned_to, assigned_at, condition)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [companyId, asset_name, asset_tag, category, assigned_to || null, assigned_to ? new Date() : null, condition]
    );

    res.status(201).json({ success: true, asset: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── 6. GET /api/hr/audit-logs — HR Immutable Audit Trail ────────────────────
router.get('/audit-logs', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const result = await pool.query(`SELECT * FROM hr_audit_logs WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100`, [companyId]);
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── Legacy Announcement & Leave Routes ─────────────────────────────────────
router.get('/announcements', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const role = req.user.role;
    let query = 'SELECT a.*, u.name as creator_name FROM announcements a JOIN users u ON a.created_by = u.id WHERE a.company_id = $1';
    let params = [companyId];
    if (role !== 'owner' && role !== 'admin' && role !== 'hr') {
      query += " AND (target_role = 'all' OR target_role = 'employee')";
    }
    query += ' ORDER BY a.created_at DESC LIMIT 50';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/announcements', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin' && req.user.role !== 'hr') {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    const { title, content, priority = 'medium', target_role = 'all' } = req.body;
    const companyId = req.user.companyId;
    const userId = req.user.userId || req.user.id;

    const result = await pool.query(
      `INSERT INTO announcements (company_id, created_by, title, content, priority, target_role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [companyId, userId, title, content, priority, target_role]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/announcements/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin' && req.user.role !== 'hr') {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    const { id } = req.params;
    const companyId = req.user.companyId;
    await pool.query('DELETE FROM announcements WHERE id = $1 AND company_id = $2', [id, companyId]);
    res.json({ success: true, message: 'Announcement deleted' });
  } catch (err) {
    console.error('Error deleting announcement:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── Leaves Endpoints ────────────────────────────────────────────────────────
router.get('/leaves', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const userId = req.user.userId || req.user.id;
    const role = req.user.role;

    let query = `SELECT * FROM hr_employee_requests WHERE company_id = $1 AND request_type = 'leave'`;
    let params = [companyId];

    if (role === 'employee') {
      query += ` AND user_id = $2`;
      params.push(userId);
    }
    query += ` ORDER BY created_at DESC LIMIT 100`;

    const result = await pool.query(query, params);
    const leaves = result.rows.map(r => {
      const details = typeof r.details === 'string' ? JSON.parse(r.details || '{}') : (r.details || {});
      return {
        id: r.id,
        user_id: r.user_id,
        employee_name: r.employee_name,
        leave_type: details.leave_type || details.type || 'Leave',
        start_date: details.start_date || details.from_date || r.created_at,
        end_date: details.end_date || details.to_date || r.created_at,
        reason: details.reason || 'No reason provided',
        status: r.status,
        hr_comments: r.hr_comments,
        created_at: r.created_at
      };
    });

    res.json(leaves);
  } catch (err) {
    console.error('Error fetching leaves:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/leaves', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const userId = req.user.userId || req.user.id;
    const userName = req.user.name || 'Employee';
    const { leave_type, start_date, end_date, reason } = req.body;

    if (!reason || !start_date || !end_date) {
      return res.status(400).json({ message: 'start_date, end_date, and reason are required' });
    }

    const details = { leave_type: leave_type || 'Casual', start_date, end_date, reason };

    const result = await pool.query(
      `INSERT INTO hr_employee_requests (company_id, user_id, employee_name, request_type, details)
       VALUES ($1, $2, $3, 'leave', $4)
       RETURNING *`,
      [companyId, userId, userName, JSON.stringify(details)]
    );

    const row = result.rows[0];
    const leave = {
      id: row.id,
      user_id: row.user_id,
      employee_name: row.employee_name,
      leave_type: details.leave_type,
      start_date: details.start_date,
      end_date: details.end_date,
      reason: details.reason,
      status: row.status,
      created_at: row.created_at
    };

    res.status(201).json(leave);
  } catch (err) {
    console.error('Error creating leave:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/leaves/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, hr_comments } = req.body;
    const companyId = req.user.companyId;
    const reviewerName = req.user.name || 'HR Manager';

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const result = await pool.query(
      `UPDATE hr_employee_requests 
       SET status = $1, hr_comments = $2, reviewed_by = $3, reviewed_at = NOW()
       WHERE id = $4 AND company_id = $5 AND request_type = 'leave'
       RETURNING *`,
      [status, hr_comments || null, reviewerName, id, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    const row = result.rows[0];
    const details = typeof row.details === 'string' ? JSON.parse(row.details || '{}') : (row.details || {});

    res.json({
      id: row.id,
      user_id: row.user_id,
      employee_name: row.employee_name,
      leave_type: details.leave_type || 'Leave',
      start_date: details.start_date || details.from_date,
      end_date: details.end_date || details.to_date,
      reason: details.reason,
      status: row.status,
      hr_comments: row.hr_comments,
      created_at: row.created_at
    });
  } catch (err) {
    console.error('Error updating leave status:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
