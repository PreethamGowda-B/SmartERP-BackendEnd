const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification } = require('../utils/notificationHelpers');

// 📥 ANNOUNCEMENTS ROUTES

// GET /api/hr/announcements - Fetch all company announcements
router.get('/announcements', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const role = req.user.role;

    // Filter by target_role if not owner
    let query = 'SELECT a.*, u.name as creator_name FROM announcements a JOIN users u ON a.created_by = u.id WHERE a.company_id = $1';
    let params = [companyId];

    if (role !== 'owner' && role !== 'admin') {
      query += " AND (target_role = 'all' OR target_role = 'employee')";
    }

    query += ' ORDER BY a.created_at DESC LIMIT 50';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching announcements:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/hr/announcements - Create an announcement (Owner/Admin)
router.post('/announcements', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const { title, content, priority = 'medium', target_role = 'all' } = req.body;
    const companyId = req.user.companyId;
    const userId = req.user.userId || req.user.id;

    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    const result = await pool.query(
      `INSERT INTO announcements (company_id, created_by, title, content, priority, target_role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [companyId, userId, title, content, priority, target_role]
    );

    const announcement = result.rows[0];

    // Broadcast notifications to all users in the company
    try {
      const usersRes = await pool.query(
        'SELECT id FROM users WHERE company_id = $1 AND id != $2',
        [companyId, userId]
      );

      for (const targetUser of usersRes.rows) {
        await createNotification({
          user_id: targetUser.id,
          company_id: companyId,
          type: 'announcement',
          title: `📢 New Announcement: ${title}`,
          message: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
          priority: priority === 'high' ? 'high' : 'medium',
          data: { announcement_id: announcement.id, url: '/owner/hr-hub' } // Frontend will handle routing
        });
      }
    } catch (notifErr) {
      console.error('Failed to broadcast announcement notifications:', notifErr.message);
    }

    res.status(201).json(announcement);
  } catch (err) {
    console.error('Error creating announcement:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/hr/announcements/:id - Delete an announcement
router.delete('/announcements/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const companyId = req.user.companyId;

    const result = await pool.query(
      'DELETE FROM announcements WHERE id = $1 AND company_id = $2 RETURNING id',
      [id, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    res.json({ message: 'Announcement deleted' });
  } catch (err) {
    console.error('Error deleting announcement:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// 📥 LEAVE REQUESTS ROUTES

// GET /api/hr/leaves - Fetch leave requests (Role-based)
router.get('/leaves', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;
    const role = req.user.role;

    let query = `
      SELECT lr.*, u.name as employee_name, u.position as employee_position
      FROM leave_requests lr
      JOIN users u ON lr.user_id = u.id
      WHERE lr.company_id = $1
    `;
    let params = [companyId];

    if (role !== 'owner' && role !== 'admin') {
      query += ' AND lr.user_id = $2';
      params.push(userId);
    }

    query += ' ORDER BY lr.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching leaves:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/hr/leaves - Submit a leave request (Employee)
router.post('/leaves', authenticateToken, async (req, res) => {
  try {
    const { leave_type, start_date, end_date, reason } = req.body;
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    if (!leave_type || !start_date || !end_date) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const result = await pool.query(
      `INSERT INTO leave_requests (company_id, user_id, leave_type, start_date, end_date, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [companyId, userId, leave_type, start_date, end_date, reason]
    );

    const leave = result.rows[0];

    // Notify company owner/admins
    try {
      const adminsRes = await pool.query(
        "SELECT id FROM users WHERE company_id = $1 AND role IN ('owner', 'admin')",
        [companyId]
      );

      for (const admin of adminsRes.rows) {
        await createNotification({
          user_id: admin.id,
          company_id: companyId,
          type: 'leave_request',
          title: '📝 New Leave Request',
          message: `An employee has requested ${leave_type} leave.`,
          priority: 'medium',
          data: { leave_id: leave.id, url: '/owner/hr-hub' }
        });
      }
    } catch (notifErr) {
      console.error('Failed to notify admins of leave request:', notifErr.message);
    }

    res.status(201).json(leave);
  } catch (err) {
    console.error('Error submitting leave:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PATCH /api/hr/leaves/:id/status - Approve or Reject leave (Owner/Admin)
router.patch('/leaves/:id/status', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const { status, admin_notes } = req.body;
    const approvedBy = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const result = await pool.query(
      `UPDATE leave_requests
       SET status = $1, admin_notes = $2, approved_by = $3, updated_at = NOW()
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [status, admin_notes, approvedBy, id, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    const updatedLeave = result.rows[0];

    // Notify the employee
    try {
      await createNotification({
        user_id: updatedLeave.user_id,
        company_id: companyId,
        type: 'leave_status_update',
        title: `🏖️ Leave Request ${status.toUpperCase()}`,
        message: `Your ${updatedLeave.leave_type} leave request has been ${status}.`,
        priority: status === 'approved' ? 'medium' : 'high',
        data: { leave_id: updatedLeave.id, status, url: '/employee/hr-hub' }
      });
    } catch (notifErr) {
      console.error('Failed to notify employee of leave status update:', notifErr.message);
    }

    res.json(updatedLeave);
  } catch (err) {
    console.error('Error updating leave status:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
