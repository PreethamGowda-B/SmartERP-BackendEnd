'use strict';

const express = require('express');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();
const ALLOWED_ROLES = new Set(['owner', 'admin']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
router.use(authenticateToken);

function principal(req) {
  const role = String(req.user?.role || '').toLowerCase();
  const companyId = String(req.user?.companyId || req.user?.company_id || '');
  const userId = String(req.user?.userId || req.user?.id || '');
  if (!ALLOWED_ROLES.has(role)) { const error = new Error('Only an Owner or Admin can manage manufacturing requests.'); error.status = 403; throw error; }
  if (!companyId || !userId) { const error = new Error('A valid company user session is required.'); error.status = 401; throw error; }
  return { companyId, userId, role };
}

function sendError(res, error) {
  if (['42P01', '42703'].includes(error?.code)) {
    return res.status(503).json({ success: false, error: 'Customer manufacturing storage is not enabled. The approved manufacturing schema migration must be applied first.' });
  }
  const status = Number(error.status) || 500;
  if (status < 500) return res.status(status).json({ success: false, error: error.message });
  console.error('Owner manufacturing request failed:', error.message);
  return res.status(500).json({ success: false, error: 'The manufacturing request could not be completed.' });
}

function route(handler) {
  return async (req, res) => {
    let client;
    try { return await handler(req, res); }
    catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally { client?.release(); }
  };
}

router.get('/', route(async (req, res) => {
  const user = principal(req);
  const status = String(req.query.status || '');
  const params = [user.companyId];
  let filter = '';
  if (status) { params.push(status); filter = ` AND r.status=$${params.length}`; }
  const result = await pool.query(
    `SELECT r.*, c.name AS customer_name, c.email AS customer_email,
            pl.production_order_id, po.order_number AS production_order_number,
            po.status AS production_status
       FROM customer_manufacturing_requests r
       LEFT JOIN customers c ON c.id::text=r.customer_id AND c.company_id::text=r.company_id
       LEFT JOIN customer_manufacturing_production_links pl
         ON pl.company_id=r.company_id AND pl.request_id=r.id
       LEFT JOIN production_orders po
         ON po.company_id=pl.company_id AND po.id=pl.production_order_id
      WHERE r.company_id=$1${filter}
      ORDER BY CASE WHEN r.status IN ('submitted','clarification_required') THEN 0 ELSE 1 END,
               r.created_at DESC LIMIT 200`, params
  );
  return res.json({ success: true, data: { requests: result.rows } });
}));

router.get('/:id', route(async (req, res) => {
  const user = principal(req);
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ success: false, error: 'Request not found.' });
  const result = await pool.query(
    `SELECT r.*, c.name AS customer_name, c.email AS customer_email,
            pl.production_order_id, po.order_number AS production_order_number
       FROM customer_manufacturing_requests r
       LEFT JOIN customers c ON c.id::text=r.customer_id AND c.company_id::text=r.company_id
       LEFT JOIN customer_manufacturing_production_links pl ON pl.company_id=r.company_id AND pl.request_id=r.id
       LEFT JOIN production_orders po ON po.company_id=pl.company_id AND po.id=pl.production_order_id
      WHERE r.company_id=$1 AND r.id=$2::uuid`, [user.companyId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ success: false, error: 'Request not found.' });
  const events = await pool.query(
    `SELECT * FROM customer_manufacturing_request_events WHERE company_id=$1 AND request_id=$2::uuid ORDER BY created_at`,
    [user.companyId, req.params.id]
  );
  return res.json({ success: true, data: { request: result.rows[0], events: events.rows } });
}));

router.post('/:id/review', route(async (req, res) => {
  const user = principal(req);
  const decision = String(req.body?.decision || '').trim();
  const message = String(req.body?.message || '').trim();
  const dueDate = req.body?.confirmedDueDate ? String(req.body.confirmedDueDate) : null;
  const commercialStatus = req.body?.commercialStatus || 'pending';
  if (!['clarification_required', 'approved', 'rejected'].includes(decision)) { const error = new Error('Choose clarification, approve, or reject.'); error.status = 400; throw error; }
  if (['clarification_required','rejected'].includes(decision) && !message) { const error = new Error('A message or reason is required.'); error.status = 400; throw error; }
  if (message.length > 4000) { const error = new Error('The response is too long.'); error.status = 400; throw error; }
  if (decision === 'approved' && !['pending','confirmed','not_required'].includes(commercialStatus)) { const error = new Error('Commercial status is invalid.'); error.status = 400; throw error; }
  if (decision === 'approved' && commercialStatus === 'pending') { const error = new Error('Confirm commercial terms or mark them not required before approval.'); error.status = 409; throw error; }
  if (dueDate) {
    const parts = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const parsed = parts && new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
    if (!parsed || parsed.toISOString().slice(0, 10) !== dueDate) { const error = new Error('Confirmed due date must be a valid YYYY-MM-DD date.'); error.status = 400; throw error; }
  }
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  const existing = await client.query(
    `SELECT * FROM customer_manufacturing_requests WHERE id=$1::uuid AND company_id=$2 FOR UPDATE`,
    [req.params.id, user.companyId]
  );
  if (!existing.rows.length) { const error = new Error('Request not found.'); error.status = 404; throw error; }
  const current = existing.rows[0];
  if (!['submitted','clarification_required'].includes(current.status)) { const error = new Error('This request is no longer open for review.'); error.status = 409; throw error; }
  const updated = await client.query(
    `UPDATE customer_manufacturing_requests
        SET status=$1, owner_response=$2, confirmed_due_date=$3::date,
            commercial_status=$4, updated_at=NOW()
      WHERE id=$5::uuid AND company_id=$6 RETURNING *`,
    [decision, message || null, dueDate, decision === 'approved' ? commercialStatus : current.commercial_status,
      req.params.id, user.companyId]
  );
  await client.query(
    `INSERT INTO customer_manufacturing_request_events
     (company_id, request_id, actor_id, actor_type, event_type, from_status, to_status, message, customer_visible, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9::jsonb)`,
    [user.companyId, req.params.id, user.userId, user.role, decision, current.status, decision,
      message || (decision === 'approved' ? 'Your manufacturing request was approved.' : null),
      JSON.stringify({ confirmedDueDate: dueDate, commercialStatus })]
  );
  await client.query('COMMIT');
  return res.json({ success: true, data: { request: updated.rows[0] } });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}));

router.post('/:id/link-production-order', route(async (req, res) => {
  const user = principal(req);
  const orderId = String(req.body?.productionOrderId || '');
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(orderId)) { const error = new Error('A valid request and production order are required.'); error.status = 400; throw error; }
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  const requestResult = await client.query(
    `SELECT * FROM customer_manufacturing_requests WHERE id=$1::uuid AND company_id=$2 FOR UPDATE`,
    [req.params.id, user.companyId]
  );
  if (!requestResult.rows.length) { const error = new Error('Request not found.'); error.status = 404; throw error; }
  const request = requestResult.rows[0];
  if (!['approved','production_scheduled'].includes(request.status)) { const error = new Error('Only an approved manufacturing request can be linked to production.'); error.status = 409; throw error; }
  const orderResult = await client.query(
    `SELECT id, customer_id, status, planned_quantity, component_name, part_number FROM production_orders WHERE id=$1::uuid AND company_id=$2 FOR UPDATE`,
    [orderId, user.companyId]
  );
  if (!orderResult.rows.length || String(orderResult.rows[0].customer_id) !== String(request.customer_id)) { const error = new Error('Production order does not belong to this request customer and company.'); error.status = 404; throw error; }
  if (Math.abs(Number(orderResult.rows[0].planned_quantity) - Number(request.requested_quantity)) > 0.0005) {
    const error = new Error('Production order quantity must match the approved customer request quantity.'); error.status = 409; throw error;
  }
  if (String(orderResult.rows[0].component_name || '').trim().toLowerCase() !== String(request.component_name || '').trim().toLowerCase()
      || (request.part_number && String(orderResult.rows[0].part_number || '').trim().toLowerCase() !== String(request.part_number).trim().toLowerCase())) {
    const error = new Error('Production order component and supplied part number must match the approved customer request.'); error.status = 409; throw error;
  }
  const prior = await client.query(`SELECT production_order_id FROM customer_manufacturing_production_links WHERE company_id=$1 AND request_id=$2::uuid`, [user.companyId, req.params.id]);
  if (prior.rows.length && String(prior.rows[0].production_order_id) !== orderId) { const error = new Error('This request is already linked to a different production order.'); error.status = 409; throw error; }
  await client.query(
    `INSERT INTO customer_manufacturing_production_links(company_id, request_id, production_order_id, linked_by)
     VALUES ($1,$2::uuid,$3::uuid,$4) ON CONFLICT (company_id, request_id) DO NOTHING`,
    [user.companyId, req.params.id, orderId, user.userId]
  );
  if (request.status !== 'production_scheduled') {
    await client.query(`UPDATE customer_manufacturing_requests SET status='production_scheduled', updated_at=NOW() WHERE id=$1::uuid AND company_id=$2`, [req.params.id,user.companyId]);
    await client.query(
      `INSERT INTO customer_manufacturing_request_events(company_id,request_id,actor_id,actor_type,event_type,from_status,to_status,message,customer_visible,details)
       VALUES ($1,$2::uuid,$3,$4,'production_order_linked',$5,'production_scheduled','Production has been scheduled.',TRUE,$6::jsonb)`,
      [user.companyId,req.params.id,user.userId,user.role,request.status,JSON.stringify({productionOrderId:orderId})]
    );
  }
  await client.query('COMMIT');
  return res.json({ success: true, data: { requestId: req.params.id, productionOrderId: orderId } });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}));

module.exports = router;
