'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { pool } = require('../../db');
const redisClient = require('../../utils/redis');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = [
  'componentName', 'partNumber', 'description', 'intendedApplication', 'materialSpecification',
  'dimensions', 'tolerance', 'finish', 'drawingNumber', 'drawingRevision', 'unit',
  'requestedCompletionDate', 'deliveryPreference', 'instructions', 'specificationMetadata',
];

function safeError(res, error) {
  if (['42P01', '42703'].includes(error?.code)) {
    return res.status(503).json({ success: false, error: 'Customer manufacturing storage is not enabled. The approved manufacturing schema migration must be applied first.' });
  }
  const status = Number(error.status) || 500;
  if (status < 500) return res.status(status).json({ success: false, error: error.message });
  console.error('Customer manufacturing request failed:', error.message);
  return res.status(500).json({ success: false, error: 'The manufacturing request could not be completed.' });
}

function currentCustomer(req) {
  const customerId = String(req.customer?.id || '');
  const companyId = String(req.customer?.companyId || '');
  if (!customerId || !companyId) {
    const error = new Error('A verified customer and company session is required.'); error.status = 401; throw error;
  }
  return { customerId, companyId };
}

function text(value, field, max, required = false) {
  const result = String(value ?? '').trim();
  if ((required && !result) || result.length > max) {
    const error = new Error(required ? `${field} is required.` : `${field} is too long.`); error.status = 400; throw error;
  }
  return result || null;
}

function isoDateOrNull(value) {
  if (value == null || value === '') return null;
  const date = String(value);
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) { const error = new Error('Requested completion date must be a valid calendar date.'); error.status = 400; throw error; }
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (parsed.toISOString().slice(0, 10) !== date) { const error = new Error('Requested completion date must be a valid calendar date.'); error.status = 400; throw error; }
  return date;
}

function customerVisibleRequest(row) {
  const productionStatus = String(row.production_status || '').toLowerCase();
  const publicStatus = productionStatus === 'in_production' ? 'in_production'
    : productionStatus === 'quality_check' ? 'quality_check'
    : productionStatus === 'ready_for_dispatch' ? 'ready_for_dispatch'
    : productionStatus === 'partially_dispatched' ? 'partially_dispatched'
    : productionStatus === 'dispatched' ? 'dispatched'
    : productionStatus === 'cancelled' ? 'cancelled'
    : productionStatus === 'rejected' ? 'rejected'
    : row.production_order_id ? 'production_scheduled' : row.status;
  return {
    id: row.id,
    requestReference: row.request_reference,
    componentName: row.component_name,
    partNumber: row.part_number,
    description: row.description,
    intendedApplication: row.intended_application,
    materialSpecification: row.material_specification,
    dimensions: row.dimensions,
    tolerance: row.tolerance,
    finish: row.finish,
    drawingNumber: row.drawing_number,
    drawingRevision: row.drawing_revision,
    requestedQuantity: Number(row.requested_quantity),
    unit: row.unit,
    requestedCompletionDate: row.requested_completion_date,
    deliveryPreference: row.delivery_preference,
    instructions: row.instructions,
    specificationMetadata: row.specification_metadata || {},
    status: publicStatus,
    ownerResponse: row.owner_response,
    confirmedDueDate: row.confirmed_due_date,
    commercialStatus: row.commercial_status,
    productionOrder: row.production_order_id ? {
      id: row.production_order_id,
      orderNumber: row.production_order_number,
      status: row.production_status,
      plannedQuantity: Number(row.production_planned_quantity),
      acceptedQuantity: Number(row.accepted_quantity || 0),
      dispatchedQuantity: Number(row.dispatched_quantity || 0),
    } : null,
    invoice: row.invoice_id && ['issued', 'sent', 'viewed', 'partially_paid', 'paid'].includes(String(row.invoice_status).toLowerCase()) ? {
      id: row.invoice_id,
      invoiceNumber: row.invoice_number,
      status: row.invoice_status,
      amount: Number(row.invoice_total || 0),
      issuedAt: row.invoice_issued_at,
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const REQUEST_SELECT = `
  SELECT r.*,
         po.id AS production_order_id, po.order_number AS production_order_number,
         po.status AS production_status, po.planned_quantity AS production_planned_quantity,
         COALESCE(q.accepted_quantity,0) AS accepted_quantity,
         COALESCE(d.dispatched_quantity,0) AS dispatched_quantity,
         inv.id AS invoice_id, inv.invoice_number, inv.status AS invoice_status,
         inv.total_amount AS invoice_total, inv.updated_at AS invoice_issued_at
    FROM customer_manufacturing_requests r
    LEFT JOIN customer_manufacturing_production_links pl
      ON pl.company_id = r.company_id AND pl.request_id = r.id
    LEFT JOIN production_orders po
      ON po.company_id = pl.company_id AND po.id = pl.production_order_id
    LEFT JOIN LATERAL (
      SELECT SUM(i.accepted_quantity) AS accepted_quantity
        FROM production_inspections i
       WHERE i.company_id = pl.company_id AND i.order_id = pl.production_order_id
    ) q ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(x.quantity),0) + COALESCE((
        SELECT SUM(a.quantity_delta) FROM production_dispatch_adjustments a
         WHERE a.company_id = pl.company_id AND a.order_id = pl.production_order_id
      ),0) AS dispatched_quantity
        FROM production_dispatches x
       WHERE x.company_id = pl.company_id AND x.order_id = pl.production_order_id
    ) d ON TRUE
    LEFT JOIN LATERAL (
      SELECT i.id, i.invoice_number, i.status, i.total_amount,
             COALESCE(i.issued_at, i.updated_at, i.created_at) AS issued_at
        FROM production_order_invoice_links il
        JOIN invoices i ON i.id = il.invoice_id AND i.company_id::text = il.company_id
       WHERE il.company_id = r.company_id AND il.production_order_id = po.id
         AND i.status <> 'draft' AND i.status <> 'cancelled'
       ORDER BY i.created_at DESC LIMIT 1
    ) inv ON TRUE`;

router.post('/', async (req, res) => {
  let client;
  try {
    const { customerId, companyId } = currentCustomer(req);
    const body = req.body || {};
    const componentName = text(body.componentName, 'Component name', 200, true);
    const description = text(body.description, 'Description', 5000, true);
    const unit = text(body.unit, 'Unit', 24, true);
    const requestedQuantity = Number(body.requestedQuantity);
    if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0 || Math.round(requestedQuantity * 1000) !== requestedQuantity * 1000) {
      const error = new Error('Quantity must be positive and use no more than three decimal places.'); error.status = 400; throw error;
    }
    const deliveryPreference = body.deliveryPreference || 'to_confirm';
    if (!['delivery', 'pickup', 'to_confirm'].includes(deliveryPreference)) { const error = new Error('Choose a supported delivery preference.'); error.status = 400; throw error; }
    const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) { const error = new Error('A valid Idempotency-Key header is required.'); error.status = 400; throw error; }

    const payload = { componentName, description, unit, requestedQuantity };
    for (const field of FIELDS) if (!(field in payload)) payload[field] = body[field] ?? null;
    payload.requestedCompletionDate = isoDateOrNull(body.requestedCompletionDate);
    if (payload.specificationMetadata && (typeof payload.specificationMetadata !== 'object' || Array.isArray(payload.specificationMetadata))) {
      const error = new Error('Technical specifications must be an object.'); error.status = 400; throw error;
    }
    const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

    client = await pool.connect();
    await client.query('BEGIN');
    const customer = await client.query(
      `SELECT id FROM customers WHERE id::text=$1::text AND company_id::text=$2::text`, [customerId, companyId]
    );
    if (!customer.rows.length) { const error = new Error('Your customer account is not linked to this company. Contact the company owner.'); error.status = 403; throw error; }

    const previous = await client.query(
      `SELECT * FROM customer_manufacturing_requests WHERE company_id=$1 AND customer_id=$2 AND idempotency_key=$3 FOR UPDATE`,
      [companyId, customerId, idempotencyKey]
    );
    if (previous.rows.length) {
      if (String(previous.rows[0].request_hash).trim() !== hash) { const error = new Error('This request key was already used for different details.'); error.status = 409; throw error; }
      await client.query('COMMIT');
      return res.json({ success: true, data: customerVisibleRequest(previous.rows[0]), replayed: true });
    }

    const id = crypto.randomUUID();
    const requestReference = `MFG-${new Date().getUTCFullYear()}-${id.slice(0, 12).toUpperCase()}`;
    const inserted = await client.query(
      `INSERT INTO customer_manufacturing_requests
       (id, company_id, customer_id, request_reference, component_name, part_number, description,
        intended_application, material_specification, dimensions, tolerance, finish, drawing_number,
        drawing_revision, requested_quantity, unit, requested_completion_date, delivery_preference,
        instructions, specification_metadata, idempotency_key, request_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22)
       ON CONFLICT (company_id, customer_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [id, companyId, customerId, requestReference, componentName,
        text(body.partNumber, 'Part number', 100), description,
        text(body.intendedApplication, 'Application', 2000), text(body.materialSpecification, 'Material', 500),
        text(body.dimensions, 'Dimensions', 500), text(body.tolerance, 'Tolerance', 300),
        text(body.finish, 'Finish', 300), text(body.drawingNumber, 'Drawing number', 100),
        text(body.drawingRevision, 'Drawing revision', 40), requestedQuantity, unit,
        payload.requestedCompletionDate, deliveryPreference, text(body.instructions, 'Instructions', 3000),
        JSON.stringify(payload.specificationMetadata || {}), idempotencyKey, hash]
    );
    if (!inserted.rows.length) {
      // A concurrent retry may have passed the initial lookup. The unique key
      // serializes that race; read its committed result and verify the payload.
      const replay = await client.query(
        `SELECT * FROM customer_manufacturing_requests
          WHERE company_id=$1 AND customer_id=$2 AND idempotency_key=$3 FOR UPDATE`,
        [companyId, customerId, idempotencyKey]
      );
      if (!replay.rows.length || String(replay.rows[0].request_hash).trim() !== hash) {
        const error = new Error('This request key was already used for different details.'); error.status = 409; throw error;
      }
      await client.query('COMMIT');
      return res.json({ success: true, data: customerVisibleRequest(replay.rows[0]), replayed: true });
    }
    await client.query(
      `INSERT INTO customer_manufacturing_request_events
       (company_id, request_id, actor_id, actor_type, event_type, to_status, message, customer_visible)
       VALUES ($1,$2,$3,'customer','request_submitted','submitted','Manufacturing request received.',TRUE)`,
      [companyId, id, customerId]
    );
    await client.query('COMMIT');
    if (redisClient?.status === 'ready') {
      redisClient.publish(`customer_manufacturing_events:${id}`, JSON.stringify({ type: 'request_submitted', requestId: id })).catch(() => {});
    }
    require('../../utils/notificationHelpers').createNotificationForOwners({
      company_id: companyId,
      type: 'production',
      title: 'New customer manufacturing request',
      message: `${componentName} · ${requestedQuantity} ${unit} submitted for review.`,
      priority: 'medium',
      data: { manufacturing_request_id: id, request_reference: requestReference, url: '/owner/manufacturing-requests' },
    }).catch((error) => console.error('Manufacturing request owner notification error:', error.message));
    return res.status(201).json({ success: true, data: customerVisibleRequest(inserted.rows[0]), replayed: false });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return safeError(res, error);
  } finally { client?.release(); }
});

router.get('/', async (req, res) => {
  try {
    const { customerId, companyId } = currentCustomer(req);
    const result = await pool.query(
      `${REQUEST_SELECT} WHERE r.customer_id=$1 AND r.company_id=$2 ORDER BY r.created_at DESC LIMIT 100`,
      [customerId, companyId]
    );
    return res.json({ success: true, data: { requests: result.rows.map(customerVisibleRequest) } });
  } catch (error) { return safeError(res, error); }
});

router.get('/:id', async (req, res) => {
  try {
    const { customerId, companyId } = currentCustomer(req);
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ success: false, error: 'Request not found.' });
    const result = await pool.query(
      `${REQUEST_SELECT} WHERE r.id=$1::uuid AND r.customer_id=$2 AND r.company_id=$3`,
      [req.params.id, customerId, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Request not found.' });
    const events = await pool.query(
      `SELECT event_type, from_status, to_status, message, details, created_at
         FROM customer_manufacturing_request_events
        WHERE company_id=$1 AND request_id=$2::uuid AND customer_visible=TRUE ORDER BY created_at`,
      [companyId, req.params.id]
    );
    const orderId = result.rows[0].production_order_id;
    let progressEvents = [];
    if (orderId) {
      const progress = await pool.query(
        `SELECT event_type, to_status, quantity, created_at
           FROM production_events
          WHERE company_id=$1 AND order_id=$2::uuid
            AND event_type = ANY($3::text[])
          ORDER BY created_at`,
        [companyId, orderId, ['production_started', 'production_quantity_reported', 'quality_inspection_requested',
          'quality_inspection_completed', 'packing_started', 'packing_completed', 'ready_for_dispatch', 'dispatch_confirmed']]
      );
      progressEvents = progress.rows.map((event) => ({
        event_type: event.event_type,
        to_status: event.to_status,
        message: event.quantity == null ? null : `Recorded quantity: ${event.quantity}`,
        created_at: event.created_at,
      }));
    }
    return res.json({ success: true, data: { request: customerVisibleRequest(result.rows[0]), events: [...events.rows, ...progressEvents].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)) } });
  } catch (error) { return safeError(res, error); }
});

module.exports = router;
