'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../../db');
const { isCustomerNotificationAuthorized } = require('../../utils/notificationAudience');

function principal(req) {
  return {
    id: String(req.customer.id || req.customer.customerId || req.customer.userId || ''),
    companyId: String(req.customer.companyId || req.customer.company_id || ''),
  };
}

function authorizedActivitySql() {
  return `a.activity_type = 'customer_notification'
    AND a.company_id::text = $1::text
    AND a.details::jsonb->>'customer_id' = $2::text
    AND COALESCE(a.details::jsonb->>'type', a.action) = ANY($3::text[])
    AND (
      (a.details::jsonb->>'job_id' IS NOT NULL AND EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.id::text = a.details::jsonb->>'job_id'
          AND j.customer_id::text = $2::text AND j.company_id::text = $1::text
      ))
      OR (a.details::jsonb->>'invoice_id' IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.id::text = a.details::jsonb->>'invoice_id'
          AND i.customer_id::text = $2::text AND i.company_id::text = $1::text
          AND EXISTS (
            SELECT 1 FROM jobs ij WHERE ij.id = i.job_id
              AND ij.customer_id::text = $2::text AND ij.company_id::text = $1::text
          )
      ))
    )`;
}

const { CUSTOMER_NOTIFICATION_TYPES } = require('../../utils/notificationAudience');
const allowedTypes = [...CUSTOMER_NOTIFICATION_TYPES];

// List/search/pagination are scoped to the authenticated customer, tenant and
// verified job/invoice relationship in SQL, with a second policy check in JS.
router.get('/', async (req, res) => {
  const { id: customerId, companyId } = principal(req);
  if (!customerId || !companyId) return res.status(403).json({ success: false, data: null, error: 'Customer account required' });
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const search = String(req.query.search || '').trim().slice(0, 120);

  try {
    const result = await pool.query(
      `SELECT a.id, a.company_id,
              COALESCE(a.details::jsonb->>'type', a.action) AS type,
              COALESCE(a.details::jsonb->>'title', a.action) AS title,
              COALESCE(a.details::jsonb->>'message', '') AS message,
              a.details::jsonb AS details, a.created_at,
              (a.customer_read_at IS NOT NULL) AS read
       FROM activities a
       WHERE ${authorizedActivitySql()}
         AND ($4::text = '' OR a.action ILIKE '%' || $4 || '%'
           OR a.details::jsonb->>'title' ILIKE '%' || $4 || '%'
           OR a.details::jsonb->>'message' ILIKE '%' || $4 || '%')
       ORDER BY a.created_at DESC LIMIT $5 OFFSET $6`,
      [companyId, customerId, allowedTypes, search, limit, offset]
    );
    const data = result.rows.filter(row => isCustomerNotificationAuthorized(row, { id: customerId, companyId }));
    return res.json({ success: true, data, error: null });
  } catch (err) {
    console.error('Customer notifications error:', err);
    return res.status(500).json({ success: false, data: null, error: 'Unable to fetch notifications' });
  }
});

router.get('/unread-count', async (req, res) => {
  const { id: customerId, companyId } = principal(req);
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM activities a
       WHERE ${authorizedActivitySql()} AND a.customer_read_at IS NULL`,
      [companyId, customerId, allowedTypes]
    );
    return res.json({ success: true, count: result.rows[0]?.count || 0 });
  } catch (err) {
    console.error('Customer unread-count error:', err);
    return res.status(500).json({ success: false, error: 'Unable to fetch unread count' });
  }
});

// Route ordering is significant: this must precede /:id/read.
router.patch('/mark-all-read', async (req, res) => {
  const { id: customerId, companyId } = principal(req);
  try {
    const result = await pool.query(
      `UPDATE activities a SET customer_read_at = NOW()
       WHERE ${authorizedActivitySql()} AND a.customer_read_at IS NULL
       RETURNING a.id`,
      [companyId, customerId, allowedTypes]
    );
    return res.json({ success: true, count: result.rows.length });
  } catch (err) {
    console.error('Customer mark-all-read error:', err);
    return res.status(500).json({ success: false, error: 'Unable to update notifications' });
  }
});

router.get('/:id', async (req, res) => {
  const { id: customerId, companyId } = principal(req);
  try {
    const result = await pool.query(
      `SELECT a.id, a.company_id,
              COALESCE(a.details::jsonb->>'type', a.action) AS type,
              COALESCE(a.details::jsonb->>'title', a.action) AS title,
              COALESCE(a.details::jsonb->>'message', '') AS message,
              a.details::jsonb AS details, a.created_at,
              (a.customer_read_at IS NOT NULL) AS read
       FROM activities a
       WHERE a.id::text = $4::text AND ${authorizedActivitySql()} LIMIT 1`,
      [companyId, customerId, allowedTypes, req.params.id]
    );
    const row = result.rows[0];
    if (!row || !isCustomerNotificationAuthorized(row, { id: customerId, companyId })) {
      return res.status(404).json({ success: false, data: null, error: 'Notification not found' });
    }
    return res.json({ success: true, data: row, error: null });
  } catch (err) {
    console.error('Customer notification detail error:', err);
    return res.status(500).json({ success: false, data: null, error: 'Unable to fetch notification' });
  }
});

router.patch('/:id/read', async (req, res) => {
  const { id: customerId, companyId } = principal(req);
  try {
    const result = await pool.query(
      `UPDATE activities a SET customer_read_at = COALESCE(a.customer_read_at, NOW())
       WHERE a.id::text = $4::text AND ${authorizedActivitySql()}
       RETURNING a.id, a.customer_read_at`,
      [companyId, customerId, allowedTypes, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'Notification not found' });
    return res.json({ success: true, id: result.rows[0].id, read: true });
  } catch (err) {
    console.error('Customer mark-read error:', err);
    return res.status(500).json({ success: false, error: 'Unable to update notification' });
  }
});

module.exports = router;
