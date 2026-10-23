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
const multer = require('multer');
const crypto = require('crypto');
const { pool } = require('../../db');
const redisClient = require('../../utils/redis');
const { createNotification } = require('../../utils/notificationHelpers');
const { requireValidFileSignature } = require('../../utils/fileValidation');
const { loadPlan, checkPlanLimit } = require('../../middleware/planMiddleware');
const { recordCompanyStorageUsage } = require('../../services/companyStorage');

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes((file.mimetype || '').split(';')[0].toLowerCase())),
});

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data, error: null });
}
function fail(res, message, statusCode = 400) {
  return res.status(statusCode).json({ success: false, data: null, error: message });
}

// ── Schema for job_messages is managed via versioned database migrations ───────

// Customer uploads are scoped to a job where the employee has accepted it.
router.post('/upload', chatUpload.single('attachment'), requireValidFileSignature({
  allowedMimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  fieldName: 'attachment',
  required: true,
}), loadPlan, checkPlanLimit('storage', { getRequestedUsage: (req) => req.file?.size || 0 }), async (req, res) => {
  const customerId = req.customer.id;
  const companyId = req.customer.companyId;
  const jobId = req.params.id;
  try {
    if (!req.file) return fail(res, 'Choose an image or PDF (up to 10 MB)', 400);
    const jobResult = await pool.query(
      `SELECT id FROM jobs WHERE id = $1 AND customer_id = $2 AND company_id::text = $3
         AND employee_status IN ('accepted', 'arrived') AND status <> 'completed'`,
      [jobId, customerId, String(companyId)]
    );
    if (!jobResult.rows.length) return fail(res, 'Chat upload is unavailable for this job', 403);
    const file = req.file;
    const storageKey = `customer-chat:${crypto.randomUUID()}`;
    await recordCompanyStorageUsage(companyId, storageKey, file.size, 'customer_chat_attachment');
    const inserted = await pool.query(
      `INSERT INTO message_media_files (file_name, file_type, file_size, data)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [file.originalname, file.mimetype, file.size, file.buffer]
    );
    const host = req.get('host') || 'api.prozync.in';
    const protocol = req.protocol === 'http' && !req.secure ? 'http' : 'https';
    const mediaUrl = `${protocol}://${host}/api/messages/media/${inserted.rows[0].id}`;
    return ok(res, {
      media_url: mediaUrl,
      media_type: file.mimetype.startsWith('image/') ? 'image' : 'document',
      file_name: file.originalname,
      file_size: file.size,
    }, 201);
  } catch (err) {
    console.error('Customer chat upload error:', err.message);
    return fail(res, 'File upload failed', 500);
  }
});

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
       WHERE id::text = $1::text AND customer_id::text = $2::text AND company_id::text = $3::text`,
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
      `SELECT id, sender_type, sender_id, sender_name, message, media_url, media_type, file_name, file_size,
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
  const { message, attachment } = req.body;

  if ((!message || !message.trim()) && !attachment?.media_url) {
    return fail(res, 'Message cannot be empty', 400);
  }

  if ((message || '').length > 2000) {
    return fail(res, 'Message too long (max 2000 characters)', 400);
  }

  try {
    // Verify job ownership and chat eligibility
    const jobResult = await pool.query(
      `SELECT j.id, j.customer_id, j.assigned_to, j.employee_status, j.company_id,
              c.name AS customer_name
       FROM jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE j.id::text = $1::text AND j.customer_id::text = $2::text
         AND j.company_id::text = $3::text`,
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

    let savedAttachment = null;
    if (attachment?.media_url) {
      const mediaId = String(attachment.media_url).match(/\/api\/messages\/media\/([0-9a-f-]{36})(?:$|\?)/i)?.[1];
      if (!mediaId) return fail(res, 'Invalid attachment reference', 400);
      const mediaResult = await pool.query(
        `SELECT file_name, file_type, file_size FROM message_media_files WHERE id = $1`,
        [mediaId]
      );
      if (!mediaResult.rows.length) return fail(res, 'Attachment not found', 400);
      const media = mediaResult.rows[0];
      if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(media.file_type)) {
        return fail(res, 'Unsupported attachment type', 400);
      }
      savedAttachment = {
        media_url: attachment.media_url,
        media_type: media.file_type.startsWith('image/') ? 'image' : 'document',
        file_name: media.file_name,
        file_size: media.file_size,
      };
    }

    const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i.test(String(companyId));
    const safeCompanyId = isUUID ? String(companyId) : null;

    // Insert message — unread for employee by default
    const result = await pool.query(
      `INSERT INTO job_messages (job_id, sender_type, sender_id, sender_name, message, company_id,
         media_url, media_type, file_name, file_size, read_by_customer, read_by_employee)
       VALUES ($1, 'customer', $2, $3, $4, $5, $6, $7, $8, $9, TRUE, FALSE)
       RETURNING id, sender_type, sender_id, sender_name, message, media_url, media_type, file_name, file_size,
         read_by_customer, read_by_employee, created_at`,
      [jobId, customerId, senderName, (message || '').trim(), safeCompanyId,
        savedAttachment?.media_url || null, savedAttachment?.media_type || null,
        savedAttachment?.file_name || null, savedAttachment?.file_size || null]
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
      const previewText = (message || '').trim() || `Sent an attachment: ${savedAttachment?.file_name || 'file'}`;
      const preview = previewText.substring(0, 50) + (previewText.length > 50 ? '...' : '');
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
          url: `/employee/messages?tab=jobs&jobId=${encodeURIComponent(jobId)}`,
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
