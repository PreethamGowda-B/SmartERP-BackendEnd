'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');
const {
  BUSINESS_TIME_ZONE,
  isSupportChannelAllowed,
  calculateFirstResponseDueAt,
  formatResponseTarget,
} = require('../services/supportPolicy');

function companyContext(req, res, next) {
  const companyId = req.user?.companyId || req.user?.company_id;
  if (!companyId || !req.plan) {
    return res.status(403).json({ message: 'Company subscription is required to access support.' });
  }
  req.supportCompanyId = String(companyId);
  next();
}

router.use(authenticateToken, loadPlan, companyContext);

router.get('/policy', (req, res) => {
  const policy = req.plan.support_policy;
  if (!policy) return res.status(503).json({ message: 'Support policy is unavailable.' });
  return res.json({
    plan_id: req.plan.id,
    plan_name: req.plan.name,
    policy,
    response_target: formatResponseTarget(policy),
    support_hours: { timezone: BUSINESS_TIME_ZONE, days: 'Monday–Friday', start: '09:00', end: '18:00' },
  });
});

router.get('/tickets', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, subject, message, status, support_channel, support_plan_id,
              support_first_response_business_hours, support_first_response_due_at,
              support_first_responded_at, created_at, replied_at
         FROM feedback
        WHERE company_id = $1 AND type = 'support'
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.supportCompanyId]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error('Support ticket list failed:', error.message);
    return res.status(503).json({ message: 'Support requests are temporarily unavailable.' });
  }
});

router.post('/tickets', async (req, res) => {
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const channel = req.body?.channel;
  const policy = req.plan.support_policy;

  if (!policy) return res.status(503).json({ message: 'Support policy is unavailable.' });
  if (!isSupportChannelAllowed(policy, channel)) {
    return res.status(403).json({
      message: 'That support channel is not included with your current plan.',
      plan: req.plan.name,
      available_channels: policy.channels,
    });
  }
  if (!subject || subject.length > 255 || !message || message.length > 5000) {
    return res.status(400).json({ message: 'Enter a subject (up to 255 characters) and message (up to 5,000 characters).' });
  }

  const dueAt = calculateFirstResponseDueAt(new Date(), policy.firstResponseBusinessHours);
  try {
    const result = await pool.query(
      `INSERT INTO feedback (
         user_id, company_id, type, subject, message, page_url, status,
         support_plan_id, support_channel, support_first_response_business_hours,
         support_first_response_due_at
       )
       VALUES ($1, $2, 'support', $3, $4, '/owner/settings?tab=support', 'new', $5, $6, $7, $8)
       RETURNING id, subject, status, support_channel, support_plan_id,
                 support_first_response_business_hours, support_first_response_due_at, created_at`,
      [
        req.user.id,
        req.supportCompanyId,
        subject,
        message,
        req.plan.id,
        channel,
        policy.firstResponseBusinessHours,
        dueAt,
      ]
    );
    const ticket = result.rows[0];
    const { sendSupportTicketNotification } = require('../services/emailNotificationService');
    void sendSupportTicketNotification({
      ticketId: ticket.id,
      companyId: req.supportCompanyId,
      userName: req.user.name,
      userEmail: req.user.email,
      planName: req.plan.name,
      channel,
      responseDueAt: ticket.support_first_response_due_at,
    });
    return res.status(201).json({
      message: 'Support request submitted.',
      ticket,
      response_target: formatResponseTarget(policy),
      support_hours: { timezone: BUSINESS_TIME_ZONE, days: 'Monday–Friday', start: '09:00', end: '18:00' },
    });
  } catch (error) {
    console.error('Support ticket creation failed:', error.message);
    return res.status(503).json({ message: 'Could not save the support request. Please retry.' });
  }
});

module.exports = router;
