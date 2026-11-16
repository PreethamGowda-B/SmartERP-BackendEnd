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
const { recordCompanyStorageUsage, removeCompanyStorageUsage } = require('../../services/companyStorage');
const { measureDatabaseFileParameter, withOutboundOperation } = require('../../utils/outboundBandwidth');
const { cloudinary, hasCloudinaryConfig } = require('../../config/cloudinary');

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
    const isImage = file.mimetype.startsWith('image/');
    const storageKey = `customer-chat:${crypto.randomUUID()}`;
    await recordCompanyStorageUsage(companyId, storageKey, file.size, 'customer_chat_attachment');

    let mediaUrl = null;

    // 1. Attempt upload to Cloudinary if credentials are configured
    if (hasCloudinaryConfig) {
      try {
        const uploadResult = await withOutboundOperation('cloudinary', 'customer_chat_upload', () => new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: `smarterp/customer-chat/${companyId}`,
              resource_type: isImage ? 'image' : 'raw',
              public_id: `cust_chat_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
              ...(isImage && { transformation: [{ width: 1200, crop: 'limit' }] })
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          stream.end(file.buffer);
        }));
        if (uploadResult && uploadResult.secure_url) {
          mediaUrl = uploadResult.secure_url;
        }
      } catch (cloudErr) {
        console.warn('⚠️ Cloudinary customer chat upload failed, falling back to database media storage:', cloudErr.message);
      }
    }

    // 2. High-performance, resilient fallback: store binary buffer in PostgreSQL message_media_files
    if (!mediaUrl) {
      const inserted = await measureDatabaseFileParameter({
        operation: 'customer_chat_attachment_insert',
        fileBytes: file.buffer.byteLength,
        run: () => pool.query(
          `INSERT INTO message_media_files (file_name, file_type, file_size, data, company_id, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [file.originalname, file.mimetype, file.size, file.buffer, String(companyId), String(customerId)]
        ),
      });
      const host = req.get('host') || 'api.prozync.in';
      const protocol = req.protocol === 'http' && !req.secure ? 'http' : 'https';
      mediaUrl = `${protocol}://${host}/api/messages/media/${inserted.rows[0].id}`;
    }

    return ok(res, {
      media_url: mediaUrl,
      media_type: isImage ? 'image' : 'document',
      file_name: file.originalname,
      file_size: file.size,
    }, 201);
  } catch (err) {
    if (storageKey) {
      await removeCompanyStorageUsage(companyId, storageKey).catch(() => {});
    }
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

      // Attachment validation:
      // 1. Ensure media is not owned by another company
      // 2. Ensure customer cannot attach internal employee documents or staff chat media
      // 3. Ensure customer cannot attach media from an unrelated job
      const existingOwnership = await pool.query(
        `SELECT 'employee_doc' AS source, company_id::text, NULL AS job_id FROM employee_documents WHERE file_url LIKE $1
         UNION ALL
         SELECT 'staff_msg' AS source, company_id::text, NULL AS job_id FROM messages WHERE media_url LIKE $1
         UNION ALL
         SELECT 'job_msg' AS source, j.company_id::text, jm.job_id::text AS job_id FROM job_messages jm JOIN jobs j ON j.id = jm.job_id WHERE jm.media_url LIKE $1`,
        [`%/api/messages/media/${mediaId}%`]
      );

      for (const row of existingOwnership.rows) {
        if (String(row.company_id) !== String(companyId)) {
          return fail(res, 'Attachment belongs to another organization', 403);
        }
        if (row.source === 'employee_doc' || row.source === 'staff_msg') {
          return fail(res, 'Unauthorized attachment reference', 403);
        }
        if (row.source === 'job_msg' && String(row.job_id) !== String(jobId)) {
          return fail(res, 'Attachment belongs to another job', 403);
        }
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
