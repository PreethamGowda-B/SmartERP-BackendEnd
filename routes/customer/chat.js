/**
 * routes/customer/chat.js
 *
 * Customer ↔ Employee chat for a specific job.
 * Chat is ONLY enabled when employee_status = 'accepted'.
 * Only the assigned employee and the job's customer can participate.
 *
 * Endpoints:
 *   GET  /jobs/:id/messages  — fetch message history
 *   POST /jobs/:id/messages  — send a message
 */

'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { pool } = require('../../db');
const redisClient = require('../../utils/redis');
const { createNotification } = require('../../utils/notificationHelpers');

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data, error: null });
}
function fail(res, message, statusCode = 400) {
  return res.status(statusCode).json({ success: false, data: null, error: message });
}

// ── Ensure job_messages table exists (idempotent) ─────────────────────────────
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id          UUID NOT NULL,
      sender_type     VARCHAR(20) NOT NULL,  -- 'customer' | 'employee'
      sender_id       UUID NOT NULL,
      sender_name     VARCHAR(255),
      message         TEXT NOT NULL,
      company_id      TEXT,
      read_by_customer  BOOLEAN NOT NULL DEFAULT FALSE,
      read_by_employee  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_job_messages_job_id ON job_messages(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_messages_created_at ON job_messages(job_id, created_at);

    -- Add unread columns to existing tables (safe to run multiple times)
    ALTER TABLE job_messages ADD COLUMN IF NOT EXISTS read_by_customer BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE job_messages ADD COLUMN IF NOT EXISTS read_by_employee BOOLEAN NOT NULL DEFAULT FALSE;
  `).catch(() => {}); // Silently ignore if already exists
}

ensureTable();

// ── GET /jobs/:id/messages ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const customerId = req.customer.id;
  const companyId  = req.customer.companyId;
  const jobId      = req.params.id;

  try {
    // Verify job ownership and that chat is enabled (employee_status = 'accepted')
    const jobResult = await pool.query(
      `SELECT id, customer_id, assigned_to, employee_status, company_id
       FROM jobs
       WHERE id = $1 AND customer_id = $2 AND company_id::text = $3`,
      [jobId, customerId, String(companyId)]
    );

    if (jobResult.rows.length === 0) {
      return fail(res, 'Job not found', 404);
    }

    const job = jobResult.rows[0];

    if (job.employee_status !== 'accepted' && job.employee_status !== 'arrived') {
      return fail(res, 'Chat is only available after a technician has accepted the job', 403);
    }

    const messages = await pool.query(
      `SELECT id, sender_type, sender_id, sender_name, message,
              read_by_customer, read_by_employee, created_at
       FROM job_messages
       WHERE job_id = $1
       ORDER BY created_at ASC
       LIMIT 200`,
      [jobId]
    );

    // Mark employee messages as read by customer (non-blocking)
    pool.query(
      `UPDATE job_messages SET read_by_customer = TRUE
       WHERE job_id = $1 AND sender_type = 'employee' AND read_by_customer = FALSE`,
      [jobId]
    ).catch(() => {});

    return ok(res, messages.rows);
  } catch (err) {
    console.error('chat GET error:', err.message);
    return fail(res, 'Server error', 500);
  }
});

// ── POST /jobs/:id/messages ───────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const customerId = req.customer.id;
  const companyId  = req.customer.companyId;
  const jobId      = req.params.id;
  const { message } = req.body;

  if (!message || !message.trim()) {
    return fail(res, 'Message cannot be empty', 400);
  }

  if (message.length > 2000) {
    return fail(res, 'Message too long (max 2000 characters)', 400);
  }

  try {
    // Verify job ownership and chat eligibility
    const jobResult = await pool.query(
      `SELECT j.id, j.customer_id, j.assigned_to, j.employee_status, j.company_id,
              c.name AS customer_name
       FROM jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE j.id = $1 AND j.customer_id = $2
         AND (j.company_id::text = $3 OR j.company_id IN (SELECT id FROM companies WHERE id::text = $3))`,
      [jobId, customerId, String(companyId)]
    );

    if (jobResult.rows.length === 0) {
      return fail(res, 'Job not found', 404);
    }

    const job = jobResult.rows[0];

    if (job.employee_status !== 'accepted' && job.employee_status !== 'arrived') {
      return fail(res, 'Chat is only available after a technician has accepted the job', 403);
    }

    const senderName = job.customer_name || 'Customer';

    const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i.test(String(companyId));
    const safeCompanyId = isUUID ? String(companyId) : null;

    // Insert message — unread for employee by default
    const result = await pool.query(
      `INSERT INTO job_messages (job_id, sender_type, sender_id, sender_name, message, company_id, read_by_customer, read_by_employee)
       VALUES ($1, 'customer', $2, $3, $4, $5, TRUE, FALSE)
       RETURNING id, sender_type, sender_id, sender_name, message, read_by_customer, read_by_employee, created_at`,
      [jobId, customerId, senderName, message.trim(), safeCompanyId]
    );

    const newMessage = result.rows[0];

    // Publish real-time event to customer SSE channel (so customer sees their own message confirmed)
    // and to employee notification channel
    if (redisClient && redisClient.status === 'ready') {
      const event = {
        type: 'chat_message',
        jobId,
        message: newMessage,
      };
      // Customer SSE channel (for real-time update in customer portal)
      redisClient.publish(`customer_job_events:${jobId}`, JSON.stringify(event))
        .catch(() => {});
      // Employee notification channel (notify assigned employee via SSE)
      if (job.assigned_to) {
        redisClient.publish(`employee_events:${job.assigned_to}`, JSON.stringify(event))
          .catch(() => {});
      }
    }

    // FIX 1: Create in-app notification for the assigned employee
    // Medium FIX: idempotency_key prevents duplicate notifications on retry
    if (job.assigned_to) {
      const preview = message.trim().substring(0, 50) + (message.trim().length > 50 ? '...' : '');
      createNotification({
        user_id: job.assigned_to,
        company_id: companyId,
        type: 'chat_message',
        title: `New message from ${senderName}`,
        message: preview,
        priority: 'high',
        actor_id: null,
        idempotency_key: `chat_cust_${newMessage.id}`,
        data: {
          job_id: jobId,
          sender_name: senderName,
          url: `/employee/jobs`,
        },
      }).catch(e => console.error('Chat notification error:', e.message));
    }

    return ok(res, newMessage, 201);
  } catch (err) {
    console.error('chat POST error:', err.message);
    return fail(res, 'Server error', 500);
  }
});

module.exports = router;
