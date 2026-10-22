const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { authenticateSuperAdmin } = require('../middleware/adminMiddleware');

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

  if (type === 'support') {
    return res.status(400).json({ error: 'Create support requests through /api/support/tickets so plan channels and response targets are enforced.' });
  }

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
router.get('/stats', authenticateToken, authenticateSuperAdmin, async (req, res) => {
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
  if (status === 'replied') {
    return res.status(400).json({ error: 'Use the reply action to record a reply after provider acceptance.' });
  }

  try {
    if (status === 'replied') {
      const companyId = req.user.role === 'super_admin'
        ? null
        : (req.user.companyId || req.user.company_id);
      if (req.user.role !== 'super_admin' && !companyId) {
        return res.status(401).json({ error: 'Unauthorized: Missing company context.' });
      }
      const ticket = await pool.query(
        `SELECT f.type FROM feedback f
          WHERE f.id = $1
            AND ($2::text IS NULL OR f.company_id = $2 OR EXISTS (
              SELECT 1 FROM users u WHERE u.id = f.user_id AND u.company_id::text = $2
            ))`,
        [id, companyId ? String(companyId) : null]
      );
      if (ticket.rows[0]?.type === 'support') {
        return res.status(400).json({ error: 'Use the support reply action to record a first response.' });
      }
    }

    let result;
    if (req.user.role === 'super_admin') {
      result = await pool.query(
        `UPDATE feedback SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [status, id]
      );
    } else {
      const companyId = req.user.companyId || req.user.company_id;
      if (!companyId) {
        return res.status(401).json({ error: 'Unauthorized: Missing company context.' });
      }
      result = await pool.query(
        `UPDATE feedback
         SET status = $1, updated_at = NOW()
         WHERE id = $2
           AND user_id IN (SELECT id FROM users WHERE company_id::text = $3::text)
         RETURNING *`,
        [status, id, String(companyId)]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Feedback not found or does not belong to your company' });
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
function createFeedbackReplyHandler({
  db = pool,
  sendEmail = (...args) => require('../services/emailNotificationService').sendFeedbackReplyEmail(...args),
  enqueueNotification = (...args) => require('../utils/queue').enqueueNotification(...args),
} = {}) {
  return async (req, res) => {
    const { id } = req.params;
    const replyMessage = typeof req.body?.replyMessage === 'string' ? req.body.replyMessage.trim() : '';
    if (!replyMessage) return res.status(400).json({ error: 'Reply message is required' });

    try {
      const feedbackRes = await db.query(
        `SELECT f.*, u.name AS user_name, u.email AS user_email, u.company_id
         FROM feedback f
         LEFT JOIN users u ON f.user_id = u.id
         WHERE f.id = $1`,
        [id]
      );
      if (feedbackRes.rows.length === 0) return res.status(404).json({ error: 'Feedback not found' });
      const feedback = feedbackRes.rows[0];
      if (feedback.status === 'replied' || feedback.replied_at) {
        return res.status(409).json({ code: 'FEEDBACK_ALREADY_REPLIED', error: 'Feedback has already been replied to' });
      }

      const isWhatsAppRecord = feedback.support_channel === 'whatsapp';
      if (!isWhatsAppRecord && !feedback.user_email) {
        return res.status(422).json({ code: 'FEEDBACK_REPLY_EMAIL_MISSING', error: 'No recipient email is available; the reply was not recorded.' });
      }

      if (feedback.status === 'in_progress' && feedback.admin_reply) {
        return res.status(409).json({
          code: 'FEEDBACK_REPLY_PENDING_VERIFICATION',
          error: feedback.admin_reply === replyMessage
            ? 'This reply is pending provider verification. Do not resend it; reconcile the provider result first.'
            : 'A different reply is already pending provider verification for this ticket.',
        });
      }
      if (feedback.admin_reply && feedback.admin_reply !== replyMessage) {
        return res.status(409).json({ code: 'FEEDBACK_REPLY_PENDING_VERIFICATION', error: 'An earlier reply is pending provider verification.' });
      }

      const previousStatus = feedback.status || 'open';
      const claim = await db.query(
        `UPDATE feedback
         SET status = 'in_progress', admin_reply = $1
         WHERE id = $2 AND COALESCE(status, 'new') <> 'replied' AND replied_at IS NULL
           AND (COALESCE(status, 'new') <> 'in_progress' OR admin_reply IS NULL)
         RETURNING id`,
        [replyMessage, id]
      );
      if (claim.rows.length === 0) {
        return res.status(409).json({ code: 'FEEDBACK_REPLY_PENDING_VERIFICATION', error: 'Another reply action is already in progress for this ticket.' });
      }

      let providerResult = null;
      if (!isWhatsAppRecord) {
        const replyHash = crypto.createHash('sha256').update(replyMessage).digest('hex');
        const idempotencyKey = `feedback-reply:${id}:${replyHash}`;
        try {
          providerResult = await sendEmail({
            email: feedback.user_email,
            name: feedback.user_name,
            subject: feedback.subject,
            originalMessage: feedback.message,
            replyMessage,
            idempotencyKey,
          });
          if (!providerResult?.accepted) throw new Error('Email provider did not confirm acceptance.');
        } catch (emailError) {
          if (emailError.providerRejected) {
            await db.query(
              `UPDATE feedback SET status = $1, admin_reply = NULL
               WHERE id = $2 AND status = 'in_progress' AND admin_reply = $3 AND replied_at IS NULL`,
              [previousStatus, id, replyMessage]
            ).catch((resetError) => console.error('[feedback-reply] Could not release rejected reply claim:', resetError.message));
            return res.status(502).json({ code: 'FEEDBACK_EMAIL_REJECTED', error: 'Email provider rejected the reply; no reply was recorded.' });
          }
          console.error('[feedback-reply] Provider outcome is uncertain; reply remains pending verification.');
          return res.status(503).json({
            code: 'FEEDBACK_REPLY_PENDING_VERIFICATION',
            error: 'Email outcome is uncertain. The reply remains pending; verify provider status before retrying.',
          });
        }
      }

      const updateRes = await db.query(
        `UPDATE feedback
         SET status = 'replied', replied_at = NOW(),
             support_first_responded_at = CASE
               WHEN type = 'support' THEN COALESCE(support_first_responded_at, NOW())
               ELSE support_first_responded_at
             END
         WHERE id = $1 AND status = 'in_progress' AND admin_reply = $2 AND replied_at IS NULL
         RETURNING *`,
        [id, replyMessage]
      );
      if (updateRes.rows.length === 0) {
        return res.status(503).json({
          code: 'FEEDBACK_REPLY_PENDING_VERIFICATION',
          error: 'The provider accepted the reply, but the ticket state could not be finalized. Reconcile before retrying.',
        });
      }

      if (feedback.user_id) {
        await enqueueNotification({
          user_id: feedback.user_id,
          company_id: feedback.company_id,
          type: 'feedback_reply',
          title: 'Support Reply Received',
          message: `We've responded to your feedback regarding: ${feedback.subject || 'Support Request'}`,
          priority: 'high',
          data: { url: '/notifications' },
        }).catch((error) => console.error('[feedback-reply] Queue notification failed:', error.message));
      }

      return res.json({
        success: true,
        provider_accepted: !isWhatsAppRecord,
        recipient_delivery_confirmed: false,
        message: isWhatsAppRecord
          ? 'WhatsApp response recorded; SmartERP did not send a WhatsApp message.'
          : 'Email provider accepted the reply; recipient delivery is not confirmed.',
        data: updateRes.rows[0],
      });
    } catch (err) {
      console.error('❌ Error replying to feedback:', err.message);
      return res.status(500).json({ error: 'Internal server error while sending reply' });
    }
  };
}

router.patch('/:id/reply', authenticateToken, authenticateSuperAdmin, createFeedbackReplyHandler());

module.exports = router;
module.exports.createFeedbackReplyHandler = createFeedbackReplyHandler;
