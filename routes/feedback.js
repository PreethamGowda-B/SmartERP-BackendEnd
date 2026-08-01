const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * @route   POST /api/feedback
 * @desc    Submit user feedback, bug reports, or feature requests
 * @access  Private
 */
router.post('/', authenticateToken, async (req, res) => {
  const {
    type, subject, message, pageUrl, page_url,
    // Enhanced fields
    portal, module, page_path, severity, category,
    ai_summary, browser, device,
  } = req.body;
  const userId = req.user.id;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO feedback (
        user_id, type, subject, message, page_url,
        portal, module, page_path, severity, category,
        ai_summary, browser, device
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        userId,
        type || 'general',
        subject || 'No Subject',
        message,
        page_url || pageUrl || '',
        portal || null,
        module || null,
        page_path || pageUrl || page_url || null,
        severity || 'medium',
        category || type || 'general',
        ai_summary || null,
        browser || null,
        device || null,
      ]
    );

    console.log(`📝 Feedback received from User ${userId}: [${type}] ${subject}`);

    res.status(201).json({
      success: true,
      message: 'Feedback submitted successfully. Thank you for helping us improve SmartERP!',
      data: result.rows[0]
    });
  } catch (err) {
    // If enhanced columns don't exist yet (migration pending), fall back to basic insert
    if (err.message && err.message.includes('column')) {
      try {
        const fallback = await pool.query(
          `INSERT INTO feedback (user_id, type, subject, message, page_url)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [userId, type || 'general', subject || 'No Subject', message, page_url || pageUrl || '']
        );
        return res.status(201).json({
          success: true,
          message: 'Feedback submitted successfully. Thank you for helping us improve SmartERP!',
          data: fallback.rows[0]
        });
      } catch (fallbackErr) {
        console.error('❌ Feedback fallback insert failed:', fallbackErr.message);
      }
    }
    console.error('❌ Error saving feedback:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route   GET /api/feedback
 * @desc    Get all feedback (Admin only)
 * @access  Private/Admin
 */
router.get('/', authenticateToken, async (req, res) => {
  if (req.user.role !== 'owner' && req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Unauthorized to view feedback' });
  }

  try {
    let query = `
       SELECT f.*, u.name as user_name, u.email as user_email 
       FROM feedback f
       LEFT JOIN users u ON f.user_id = u.id
    `;
    let params = [];

    if (req.user.role !== 'super_admin') {
      query += " WHERE u.company_id::text = $1";
      params.push(String(req.user.companyId));
    }

    query += " ORDER BY f.created_at DESC";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching feedback:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route   GET /api/feedback/stats
 * @desc    Get feedback aggregate stats (Super Admin only)
 * @access  Private/SuperAdmin
 */
router.get('/stats', authenticateToken, async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only superadmins can view feedback stats' });
  }

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [totalRes, todayRes, byTypeRes, byStatusRes, openRes, resolvedRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM feedback`),
      pool.query(`SELECT COUNT(*) FROM feedback WHERE created_at >= $1`, [today]),
      pool.query(`SELECT type, COUNT(*) as cnt FROM feedback GROUP BY type ORDER BY cnt DESC`),
      pool.query(`SELECT status, COUNT(*) as cnt FROM feedback GROUP BY status`),
      pool.query(`SELECT COUNT(*) FROM feedback WHERE status IN ('new', 'open', 'in_progress')`),
      pool.query(`SELECT COUNT(*) FROM feedback WHERE status = 'replied' AND replied_at >= $1`, [monthStart]),
    ]);

    const byType = {};
    byTypeRes.rows.forEach(r => { byType[r.type] = parseInt(r.cnt); });
    const byStatus = {};
    byStatusRes.rows.forEach(r => { byStatus[r.status || 'new'] = parseInt(r.cnt); });

    res.json({
      total: parseInt(totalRes.rows[0]?.count || 0),
      today: parseInt(todayRes.rows[0]?.count || 0),
      openTickets: parseInt(openRes.rows[0]?.count || 0),
      resolvedThisMonth: parseInt(resolvedRes.rows[0]?.count || 0),
      byType,
      byStatus,
    });
  } catch (err) {
    console.error('❌ Error fetching feedback stats:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route   PATCH /api/feedback/:id/status
 * @desc    Update feedback ticket status (Super Admin / Owner only)
 * @access  Private/Admin
 */
router.patch('/:id/status', authenticateToken, async (req, res) => {
  if (req.user.role !== 'super_admin' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Unauthorized to update feedback status' });
  }

  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['new', 'open', 'in_progress', 'resolved', 'closed', 'replied'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const result = await pool.query(
      `UPDATE feedback SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Feedback not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('❌ Error updating feedback status:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route   PATCH /api/feedback/:id/reply
 * @desc    Reply to a user's feedback (Superadmin only)
 * @access  Private/SuperAdmin
 */
router.patch('/:id/reply', authenticateToken, async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only superadmins can reply to feedback' });
  }

  const { id } = req.params;
  const { replyMessage } = req.body;

  if (!replyMessage || !replyMessage.trim()) {
    return res.status(400).json({ error: 'Reply message is required' });
  }

  try {
    const feedbackRes = await pool.query(
      `SELECT f.*, u.name as user_name, u.email as user_email, u.company_id
       FROM feedback f
       LEFT JOIN users u ON f.user_id = u.id
       WHERE f.id = $1`,
      [id]
    );

    if (feedbackRes.rows.length === 0) {
      return res.status(404).json({ error: 'Feedback not found' });
    }

    const feedback = feedbackRes.rows[0];

    if (feedback.status === 'replied') {
      return res.status(400).json({ error: 'Feedback has already been replied to' });
    }

    const updateRes = await pool.query(
      `UPDATE feedback 
       SET status = 'replied', admin_reply = $1, replied_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [replyMessage, id]
    );

    if (feedback.user_email) {
      const { sendFeedbackReplyEmail } = require('../services/emailNotificationService');
      await sendFeedbackReplyEmail({
        email: feedback.user_email,
        name: feedback.user_name,
        subject: feedback.subject,
        originalMessage: feedback.message,
        replyMessage: replyMessage
      });
    }

    if (feedback.user_id) {
       const { enqueueNotification } = require('../utils/queue');
       await enqueueNotification({
          user_id: feedback.user_id,
          company_id: feedback.company_id,
          type: 'feedback_reply',
          title: 'Support Reply Received',
          message: `We've responded to your feedback regarding: ${feedback.subject || 'Support Request'}`,
          priority: 'high',
          data: { url: '/notifications' }
       }).catch(e => console.error('Queue Notification Error for feedback reply:', e.message));
    }

    res.json({
      success: true,
      message: 'Reply sent successfully',
      data: updateRes.rows[0]
    });

  } catch (err) {
    console.error('❌ Error replying to feedback:', err.message);
    res.status(500).json({ error: 'Internal server error while sending reply' });
  }
});

module.exports = router;
