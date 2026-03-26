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
  const { type, subject, message, pageUrl } = req.body;
  const userId = req.user.id;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO feedback (user_id, type, subject, message, page_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, type || 'general', subject || 'No Subject', message, pageUrl || '']
    );

    console.log(`📝 Feedback received from User ${userId}: [${type}] ${subject}`);

    res.status(201).json({
      success: true,
      message: 'Feedback submitted successfully. Thank you for helping us improve SmartERP!',
      data: result.rows[0]
    });
  } catch (err) {
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
  // Only owners or admins can view feedback
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

    // Isolation: Only super_admin sees everything. Others see only their company's feedback.
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
    // 1. Fetch the original feedback and user details
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

    // 2. Update the feedback record
    const updateRes = await pool.query(
      `UPDATE feedback 
       SET status = 'replied', admin_reply = $1, replied_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [replyMessage, id]
    );

    // 3. Send Email Notification
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

    // 4. Send In-App Notification using Queues (or fallback)
    if (feedback.user_id) {
       const { enqueueNotification } = require('../utils/queue');
       await enqueueNotification({
          user_id: feedback.user_id,
          company_id: feedback.company_id, // Might be null if user has no company
          type: 'feedback_reply',
          title: 'Support Reply Received',
          message: `We've responded to your feedback regarding: ${feedback.subject || 'Support Request'}`,
          priority: 'high',
          data: { url: '/notifications' } // Or wherever they should view it
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
