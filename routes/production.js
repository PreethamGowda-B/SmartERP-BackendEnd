const express = require('express');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const {
  ProductionRuleError,
  assertProductionReport,
  assertQualityOutcome,
  assertDispatchQuantity,
  assertStatusTransition,
  deriveDispatchStatus,
  ORDER_STATUSES,
} = require('../services/productionDispatchDomain');
const { createNotification, createNotificationForOwners } = require('../utils/notificationHelpers');

const router = express.Router();
const OWNER_ROLES = new Set(['owner', 'admin']);
const INSPECTOR_ROLES = new Set(['owner', 'admin']);
const VALID_STATUSES = new Set(Object.values(ORDER_STATUSES));
const EMPLOYEE_ROLES = new Set(['employee', 'staff', 'technician']);
const REPLAYED = Symbol('production-idempotency-replay');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function principal(req) {
  const id = String(req.user?.userId || req.user?.id || '');
  const companyId = String(req.user?.companyId || req.user?.company_id || '');
  const role = String(req.user?.role || '').toLowerCase();
  if (!UUID_RE.test(id) || !companyId) {
    const error = new Error('A valid employee and company session is required.');
    error.status = 401;
    throw error;
  }
  return { id, companyId, role };
}

function requireRole(user, roles) {
  if (!roles.has(user.role)) {
    const error = new Error('You are not authorized to use this production action.');
    error.status = 403;
    throw error;
  }
}

function requireText(value, name, max = 255) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) {
    const error = new Error(`${name} is required and must be no longer than ${max} characters.`);
    error.status = 400;
    throw error;
  }
  return text;
}

function productionUnavailable(error) {
  return ['42P01', '42703', '42883', '42501'].includes(error?.code);
}

function sendError(res, error) {
  if (productionUnavailable(error)) {
    return res.status(503).json({
      success: false,
      code: 'PRODUCTION_SCHEMA_NOT_ACTIVE',
      message: 'Production & Dispatch is unavailable because its approved schema or application database permissions are not active.',
    });
  }
  if (error instanceof ProductionRuleError) {
    return res.status(400).json({ success: false, code: error.code, message: error.message });
  }
  const status = Number(error?.status) || 500;
  if (status < 500) return res.status(status).json({ success: false, message: error.message });
  console.error('Production & Dispatch request failed:', error);
  return res.status(500).json({ success: false, message: 'The production request could not be completed.' });
}

function route(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req, res);
      if (!res.headersSent) res.json({ success: true, data });
    } catch (error) {
      sendError(res, error);
    }
  };
}

function mutationKey(req) {
  const key = String(req.get('Idempotency-Key') || '').trim();
  if (key.length < 8 || key.length > 200) {
    const error = new Error('A valid Idempotency-Key header is required for this operation.');
    error.status = 400;
    throw error;
  }
  return key;
}

async function mutate(req, scope, operation) {
  const user = principal(req);
  const key = mutationKey(req);
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ body: req.body || {}, params: req.params || {} })).digest('hex');
  const lockKey = `${user.companyId}:${user.id}:${scope}:${key}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
    const previous = await client.query(
      `SELECT request_hash, response_json FROM production_idempotency
       WHERE company_id::text = $1::text AND actor_id::text = $2::text AND scope = $3 AND request_key = $4`,
      [user.companyId, user.id, scope, key]
    );
    if (previous.rows.length) {
      if (previous.rows[0].request_hash !== requestHash) {
        const error = new Error('This idempotency key was already used with a different request.');
        error.status = 409;
        throw error;
      }
      const response = previous.rows[0].response_json;
      if (response && typeof response === 'object') response[REPLAYED] = true;
      await client.query('COMMIT');
      return response;
    }

    const response = await operation(client, user);
    await client.query(
      `INSERT INTO production_idempotency(company_id, actor_id, scope, request_key, request_hash, response_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [user.companyId, user.id, scope, key, requestHash, JSON.stringify(response)]
    );
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const ORDER_SELECT = `
  SELECT o.id, o.company_id, o.order_number, o.customer_id, o.customer_order_reference,
         o.component_name, o.part_number, o.drawing_number, o.drawing_revision,
         o.planned_quantity, o.unit, o.due_date, o.priority, o.machine_id,
         o.assigned_employee_id, o.job_id, o.instructions, o.status, o.created_at, o.updated_at,
         COALESCE(c.name, 'Customer') AS customer_name,
         m.machine_name,
         COALESCE(assignee.name, assignee.email) AS assigned_employee_name,
         b.id AS active_batch_id, b.status AS active_batch_status,
         COALESCE(t.good_quantity, 0) AS good_quantity,
         COALESCE(t.rejected_quantity, 0) AS rejected_quantity,
         COALESCE(t.rework_quantity, 0) AS rework_quantity,
         COALESCE(t.accepted_quantity, 0) AS accepted_quantity,
         COALESCE(t.dispatched_quantity, 0) AS dispatched_quantity,
         GREATEST(COALESCE(t.accepted_quantity, 0) - COALESCE(t.dispatched_quantity, 0), 0) AS outstanding_quantity,
         COALESCE(b.has_report, FALSE) AS active_batch_has_report,
         latest_inspection.result AS latest_inspection_result,
         latest_inspection.reason AS latest_inspection_reason,
         latest_inspection.inspected_at AS latest_inspection_at
    FROM production_orders o
    LEFT JOIN customers c ON c.id::text = o.customer_id::text AND c.company_id::text = o.company_id::text
    LEFT JOIN customer_machines m ON m.id::text = o.machine_id::text AND m.company_id::text = o.company_id::text
    LEFT JOIN users assignee ON assignee.id::text = o.assigned_employee_id::text AND assignee.company_id::text = o.company_id::text
    LEFT JOIN LATERAL (
      SELECT pb.id, pb.status,
             EXISTS(SELECT 1 FROM production_reports pr WHERE pr.company_id::text = o.company_id::text AND pr.batch_id = pb.id) AS has_report
        FROM production_batches pb
       WHERE pb.company_id::text = o.company_id::text AND pb.order_id = o.id AND pb.status IN ('in_production','submitted')
       ORDER BY pb.started_at DESC LIMIT 1
    ) b ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        (SELECT COALESCE(SUM(r.good_quantity), 0) FROM production_reports r WHERE r.company_id::text = o.company_id::text AND r.order_id = o.id) AS good_quantity,
        (SELECT COALESCE(SUM(r.rejected_quantity), 0) FROM production_reports r WHERE r.company_id::text = o.company_id::text AND r.order_id = o.id) AS rejected_quantity,
        (SELECT COALESCE(SUM(r.rework_quantity), 0) FROM production_reports r WHERE r.company_id::text = o.company_id::text AND r.order_id = o.id) AS rework_quantity,
        (SELECT COALESCE(SUM(i.accepted_quantity), 0) FROM production_inspections i WHERE i.company_id::text = o.company_id::text AND i.order_id = o.id) AS accepted_quantity,
        (SELECT COALESCE(SUM(d.quantity), 0) + COALESCE((SELECT SUM(a.quantity_delta) FROM production_dispatch_adjustments a WHERE a.company_id::text = o.company_id::text AND a.order_id = o.id), 0) FROM production_dispatches d WHERE d.company_id::text = o.company_id::text AND d.order_id = o.id) AS dispatched_quantity
    ) t ON TRUE
    LEFT JOIN LATERAL (
      SELECT i.result, i.reason, i.inspected_at FROM production_inspections i
       WHERE i.company_id::text=o.company_id::text AND i.order_id=o.id
       ORDER BY i.inspected_at DESC LIMIT 1
    ) latest_inspection ON TRUE
   WHERE o.company_id::text = $1::text`;

function mapOrder(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerOrderReference: row.customer_order_reference,
    componentName: row.component_name,
    partNumber: row.part_number,
    drawingNumber: row.drawing_number,
    drawingRevision: row.drawing_revision,
    plannedQuantity: Number(row.planned_quantity),
    unit: row.unit,
    goodQuantity: Number(row.good_quantity),
    rejectedQuantity: Number(row.rejected_quantity),
    reworkQuantity: Number(row.rework_quantity),
    acceptedQuantity: Number(row.accepted_quantity),
    dispatchedQuantity: Number(row.dispatched_quantity),
    outstandingQuantity: Number(row.outstanding_quantity),
    machineId: row.machine_id,
    machineName: row.machine_name,
    assignedEmployeeId: row.assigned_employee_id,
    assignedEmployeeName: row.assigned_employee_name,
    activeBatchId: row.active_batch_id,
    activeBatchHasReport: row.active_batch_has_report,
    latestInspectionResult: row.latest_inspection_result,
    latestInspectionReason: row.latest_inspection_reason,
    latestInspectionAt: row.latest_inspection_at,
    jobId: row.job_id,
    instructions: row.instructions,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function fetchOrder(client, orderId, companyId, lock = false) {
  const result = await client.query(
    `SELECT id, company_id, order_number, customer_id, planned_quantity, status, assigned_employee_id,
            machine_id, due_date, updated_at
       FROM production_orders
      WHERE id::text = $1::text AND company_id::text = $2::text${lock ? ' FOR UPDATE' : ''}`,
    [orderId, companyId]
  );
  if (!result.rows.length) {
    const error = new Error('Production order was not found.'); error.status = 404; throw error;
  }
  return result.rows[0];
}

async function appendEvent(client, user, { orderId, batchId = null, type, fromStatus = null, toStatus = null, quantity = null, reason = null, details = {} }) {
  const actor = await client.query(`SELECT COALESCE(name,email) AS display_name FROM users WHERE id::text=$1::text AND company_id::text=$2::text`, [user.id,user.companyId]);
  await client.query(
    `INSERT INTO production_events(company_id, order_id, batch_id, actor_id, actor_name, event_type, from_status, to_status, quantity, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [user.companyId, orderId, batchId, user.id, actor.rows[0]?.display_name || 'Unknown user', type, fromStatus, toStatus, quantity, reason, JSON.stringify(details)]
  );
}

async function getActorName(client, user) {
  const result = await client.query(`SELECT COALESCE(name,email) AS display_name FROM users WHERE id::text=$1::text AND company_id::text=$2::text`, [user.id,user.companyId]);
  return result.rows[0]?.display_name || 'Unknown user';
}

router.use(authenticateToken);

router.get('/dashboard', route(async (req) => {
  const user = principal(req); requireRole(user, OWNER_ROLES);
  const result = await pool.query(
    `SELECT status, COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE due_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND status NOT IN ('dispatched','cancelled','rejected'))::int AS overdue_count
       FROM production_orders WHERE company_id::text = $1::text GROUP BY status`,
    [user.companyId]
  );
  const counts = {};
  let overdueCount = 0;
  for (const row of result.rows) { counts[row.status] = Number(row.count); overdueCount += Number(row.overdue_count); }
  const quantities = await pool.query(
    `SELECT COALESCE(SUM(r.rejected_quantity),0) AS rejected_quantity,
            COALESCE(SUM(r.rework_quantity),0) AS rework_quantity
       FROM production_reports r WHERE r.company_id::text = $1::text`, [user.companyId]
  );
  return { counts, overdueCount, rejectedQuantity: Number(quantities.rows[0].rejected_quantity), reworkQuantity: Number(quantities.rows[0].rework_quantity) };
}));

router.get('/reports', route(async (req) => {
  const user = principal(req); requireRole(user, OWNER_ROLES);
  const validDate = (value) => {
    if (!value) return null;
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.toISOString().slice(0, 10) === value ? value : null;
  };
  const from = validDate(req.query.from);
  const to = validDate(req.query.to);
  if ((req.query.from && !from) || (req.query.to && !to) || (from && to && from > to)) { const e = new Error('Use a valid date range in YYYY-MM-DD format.'); e.status=400; throw e; }
  const params = [user.companyId, from || '0001-01-01', to || '9999-12-31'];
  const [production, inspections, dispatches, outstanding] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(good_quantity),0) good_quantity, COALESCE(SUM(rejected_quantity),0) rejected_quantity, COALESCE(SUM(rework_quantity),0) rework_quantity, COUNT(*)::int report_count FROM production_reports WHERE company_id::text=$1::text AND (reported_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date`, params),
    pool.query(`SELECT COUNT(*)::int inspection_count, COALESCE(SUM(accepted_quantity),0) accepted_quantity, COALESCE(SUM(rejected_quantity),0) rejected_quantity, COALESCE(SUM(rework_quantity),0) rework_quantity FROM production_inspections WHERE company_id::text=$1::text AND (inspected_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date`, params),
    pool.query(`SELECT COUNT(*)::int dispatch_count, COALESCE(SUM(quantity),0) dispatched_quantity FROM production_dispatches WHERE company_id::text=$1::text AND (dispatched_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date`, params),
    pool.query(`SELECT COUNT(*)::int open_order_count, COALESCE(SUM(GREATEST(COALESCE(q.accepted,0)-COALESCE(q.shipped,0),0)),0) accepted_quantity_awaiting_dispatch FROM production_orders o LEFT JOIN LATERAL (SELECT (SELECT COALESCE(SUM(i.accepted_quantity),0) FROM production_inspections i WHERE i.company_id::text=o.company_id::text AND i.order_id=o.id) accepted, (SELECT COALESCE(SUM(d.quantity),0)+COALESCE((SELECT SUM(a.quantity_delta) FROM production_dispatch_adjustments a WHERE a.company_id::text=o.company_id::text AND a.order_id=o.id),0) FROM production_dispatches d WHERE d.company_id::text=o.company_id::text AND d.order_id=o.id) shipped) q ON TRUE WHERE o.company_id::text=$1::text AND o.status NOT IN ('dispatched','cancelled','rejected')`, [user.companyId]),
  ]);
  const p = production.rows[0], i = inspections.rows[0], d = dispatches.rows[0], o = outstanding.rows[0];
  const attempted = Number(p.good_quantity) + Number(p.rejected_quantity) + Number(p.rework_quantity);
  return {
    from: from || null, to: to || null,
    production: { reportCount: Number(p.report_count), goodQuantity: Number(p.good_quantity), rejectedQuantity: Number(p.rejected_quantity), reworkQuantity: Number(p.rework_quantity), rejectRate: attempted ? Number(p.rejected_quantity) / attempted : 0 },
    quality: { inspectionCount: Number(i.inspection_count), acceptedQuantity: Number(i.accepted_quantity), rejectedQuantity: Number(i.rejected_quantity), reworkQuantity: Number(i.rework_quantity) },
    dispatch: { dispatchCount: Number(d.dispatch_count), dispatchedQuantity: Number(d.dispatched_quantity) },
    outstanding: { orderCount: Number(o.open_order_count), acceptedQuantity: Number(o.accepted_quantity_awaiting_dispatch) },
  };
}));

router.get('/references', route(async (req) => {
  const user = principal(req); requireRole(user, OWNER_ROLES);
  const companyId = user.companyId;
  const [customers, machines, employees, inventory, jobs] = await Promise.all([
    pool.query(`SELECT id::text AS id, name FROM customers WHERE company_id::text = $1::text ORDER BY name LIMIT 500`, [companyId]),
    pool.query(`SELECT id::text AS id, machine_name AS name FROM customer_machines WHERE company_id::text = $1::text AND COALESCE(status,'operational') <> 'decommissioned' ORDER BY machine_name LIMIT 500`, [companyId]),
    pool.query(`SELECT id::text AS id, COALESCE(name,email) AS name FROM users WHERE company_id::text = $1::text AND role IN ('employee','staff','technician') AND COALESCE(is_active,TRUE) = TRUE ORDER BY name LIMIT 500`, [companyId]),
    pool.query(`SELECT id::text AS id, name, unit FROM inventory_items WHERE company_id::text = $1::text AND COALESCE(is_deleted,FALSE) = FALSE ORDER BY name LIMIT 1000`, [companyId]),
    pool.query(`SELECT j.id::text AS id, j.title, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id::text = j.customer_id::text AND c.company_id::text = j.company_id::text WHERE j.company_id::text = $1::text ORDER BY j.created_at DESC LIMIT 500`, [companyId]),
  ]);
  return {
    customers: customers.rows,
    machines: machines.rows,
    employees: employees.rows,
    inventoryItems: inventory.rows,
    jobs: jobs.rows.map((row) => ({ id: row.id, title: row.title, customerName: row.customer_name })),
  };
}));

router.get('/orders', route(async (req) => {
  const user = principal(req); requireRole(user, OWNER_ROLES);
  const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(req.query.pageSize, 10) || 20));
  const params = [user.companyId];
  let where = '';
  const add = (sql, value) => { params.push(value); where += sql.replaceAll('?', `$${params.length}`); };
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q) add(` AND (o.order_number ILIKE '%' || ? || '%' OR o.component_name ILIKE '%' || ? || '%' OR o.part_number ILIKE '%' || ? || '%' OR COALESCE(o.drawing_number,'') ILIKE '%' || ? || '%' OR COALESCE(c.name,'') ILIKE '%' || ? || '%' OR COALESCE(o.customer_order_reference,'') ILIKE '%' || ? || '%')`, q);
  if (req.query.status) {
    const value = String(req.query.status);
    if (value === 'overdue') where += ` AND o.due_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND o.status NOT IN ('dispatched','cancelled','rejected')`;
    else if (value === 'quality_loss') where += ` AND EXISTS (SELECT 1 FROM production_reports x WHERE x.company_id::text=o.company_id::text AND x.order_id=o.id AND (x.rejected_quantity > 0 OR x.rework_quantity > 0))`;
    else if (VALID_STATUSES.has(value)) add(' AND o.status = ?', value);
    else { const error = new Error('Unknown production status filter.'); error.status=400; throw error; }
  }
  for (const [query, column] of [['machineId','o.machine_id'],['operatorId','o.assigned_employee_id'],['customerId','o.customer_id'],['priority','o.priority']]) {
    if (req.query[query]) add(` AND ${column}::text = ?::text`, String(req.query[query]));
  }
  const countSql = `SELECT COUNT(*)::int AS total FROM production_orders o LEFT JOIN customers c ON c.id::text=o.customer_id::text AND c.company_id::text=o.company_id::text WHERE o.company_id::text=$1::text${where}`;
  const count = await pool.query(countSql, params);
  const listParams = [...params, pageSize, (page - 1) * pageSize];
  const result = await pool.query(
    `${ORDER_SELECT}${where} ORDER BY o.due_date ASC, o.updated_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );
  return { orders: result.rows.map(mapOrder), page, pageSize, total: count.rows[0].total };
}));

router.get('/my-orders', route(async (req) => {
  const user = principal(req);
  if (!EMPLOYEE_ROLES.has(user.role)) { const e = new Error('Only employees can view assigned production orders.'); e.status=403; throw e; }
  const result = await pool.query(
    `${ORDER_SELECT} AND o.assigned_employee_id::text = $2::text AND o.status NOT IN ('dispatched','cancelled') ORDER BY o.due_date ASC, o.updated_at DESC`,
    [user.companyId, user.id]
  );
  return { orders: result.rows.map(mapOrder) };
}));

router.get('/orders/:orderId', route(async (req) => {
  const user = principal(req);
  const client = await pool.connect();
  try {
    const result = await client.query(`${ORDER_SELECT} AND o.id::text = $2::text`, [user.companyId, req.params.orderId]);
    if (!result.rows.length) { const e = new Error('Production order was not found.'); e.status = 404; throw e; }
    const row = result.rows[0];
    if (!OWNER_ROLES.has(user.role) && !(EMPLOYEE_ROLES.has(user.role) && String(row.assigned_employee_id) === user.id)) {
      const e = new Error('Production order was not found.'); e.status = 404; throw e;
    }
    const [batches, reports, materials, inspections, dispatches, events] = await Promise.all([
      client.query(`SELECT b.*, COALESCE(SUM(r.good_quantity),0) good_quantity, COALESCE(SUM(r.rejected_quantity),0) rejected_quantity, COALESCE(SUM(r.rework_quantity),0) rework_quantity FROM production_batches b LEFT JOIN production_reports r ON r.company_id::text=b.company_id::text AND r.batch_id=b.id WHERE b.company_id::text=$1::text AND b.order_id=$2 GROUP BY b.id ORDER BY b.batch_number`, [user.companyId, req.params.orderId]),
      client.query(`SELECT r.*, r.reported_by_name AS actor_name FROM production_reports r WHERE r.company_id::text=$1::text AND r.order_id=$2 ORDER BY r.reported_at`, [user.companyId, req.params.orderId]),
      client.query(`SELECT m.id, m.inventory_item_id, i.name AS item_name, m.planned_quantity, m.unit FROM production_order_materials m LEFT JOIN inventory_items i ON i.id::text=m.inventory_item_id::text AND i.company_id::text=m.company_id::text WHERE m.company_id::text=$1::text AND m.order_id=$2 ORDER BY m.created_at`, [user.companyId, req.params.orderId]),
      client.query(`SELECT i.* FROM production_inspections i WHERE i.company_id::text=$1::text AND i.order_id=$2 ORDER BY i.inspected_at DESC`, [user.companyId, req.params.orderId]),
      client.query(`SELECT d.* FROM production_dispatches d WHERE d.company_id::text=$1::text AND d.order_id=$2 ORDER BY d.dispatched_at DESC`, [user.companyId, req.params.orderId]),
      client.query(`SELECT e.* FROM production_events e WHERE e.company_id::text=$1::text AND e.order_id=$2 ORDER BY e.created_at`, [user.companyId, req.params.orderId]),
    ]);
    return { order: mapOrder(row), batches: batches.rows, reports: reports.rows, materials: materials.rows, inspections: inspections.rows, dispatches: dispatches.rows, events: events.rows };
  } finally { client.release(); }
}));

router.post('/orders', route(async (req, res) => {
  const user = principal(req); requireRole(user, OWNER_ROLES);
  const created = await mutate(req, 'create-production-order', async (client) => {
    const body = req.body || {};
    const customerId = requireText(body.customerId, 'Customer', 100);
    const componentName = requireText(body.componentName, 'Component name', 200);
    const partNumber = requireText(body.partNumber, 'Part number', 100);
    const unit = requireText(body.unit, 'Unit', 24);
    const quantity = Number(body.plannedQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || Math.round(quantity * 1000) !== quantity * 1000) { const e = new Error('Planned quantity must be positive and use no more than three decimal places.'); e.status=400; throw e; }
    const dueDate = String(body.dueDate || '');
    const dateParts = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const dueDateObj = dateParts ? new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]))) : null;
    if (!dueDateObj || dueDateObj.toISOString().slice(0, 10) !== dueDate) { const e = new Error('A valid completion date is required.'); e.status=400; throw e; }
    const priority = ['low','medium','high','urgent'].includes(body.priority) ? body.priority : 'medium';
    const customer = await client.query(`SELECT id FROM customers WHERE id::text=$1::text AND company_id::text=$2::text`, [customerId, user.companyId]);
    if (!customer.rows.length) { const e = new Error('Customer is not available in this company.'); e.status=400; throw e; }
    if (body.machineId) {
      const machine = await client.query(`SELECT id FROM customer_machines WHERE id::text=$1::text AND company_id::text=$2::text AND COALESCE(status,'operational') <> 'decommissioned'`, [String(body.machineId), user.companyId]);
      if (!machine.rows.length) { const e = new Error('Machine is not available in this company.'); e.status=400; throw e; }
    }
    if (body.assignedEmployeeId) {
      const employee = await client.query(`SELECT id FROM users WHERE id::text=$1::text AND company_id::text=$2::text AND role IN ('employee','staff','technician') AND COALESCE(is_active,TRUE)=TRUE`, [String(body.assignedEmployeeId), user.companyId]);
      if (!employee.rows.length) { const e = new Error('Assigned operator is not available in this company.'); e.status=400; throw e; }
    }
    if (body.jobId) {
      const job = await client.query(`SELECT id, customer_id FROM jobs WHERE id::text=$1::text AND company_id::text=$2::text`, [String(body.jobId), user.companyId]);
      if (!job.rows.length || (job.rows[0].customer_id && String(job.rows[0].customer_id) !== customerId)) { const e = new Error('Related service job does not belong to the selected customer and company.'); e.status=400; throw e; }
    }
    const materialsById = new Map();
    for (const line of Array.isArray(body.materials) ? body.materials : []) {
      const itemId = requireText(String(line.inventoryItemId || ''), 'Inventory item', 100);
      const planned = Number(line.plannedQuantity);
      if (!Number.isFinite(planned) || planned <= 0 || Math.round(planned * 1000) !== planned * 1000) { const e = new Error('Planned material quantity must be positive and use no more than three decimal places.'); e.status=400; throw e; }
      materialsById.set(itemId, (materialsById.get(itemId) || 0) + planned);
    }
    if (materialsById.size) {
      const verified = await client.query(`SELECT id::text FROM inventory_items WHERE company_id::text=$1::text AND COALESCE(is_deleted,FALSE)=FALSE AND id::text = ANY($2::text[])`, [user.companyId, [...materialsById.keys()]]);
      if (verified.rows.length !== materialsById.size) { const e = new Error('One or more material items are not available in this company.'); e.status=400; throw e; }
    }
    const yearResult = await client.query(`SELECT EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Asia/Kolkata')::int AS year`);
    const year = yearResult.rows[0].year;
    const sequence = await client.query(
      `INSERT INTO production_sequences(company_id, sequence_kind, sequence_year, next_value) VALUES ($1,'order',$2,1)
       ON CONFLICT(company_id, sequence_kind, sequence_year) DO UPDATE SET next_value=production_sequences.next_value+1 RETURNING next_value`, [user.companyId, year]
    );
    const orderNumber = `PROD-${year}-${String(sequence.rows[0].next_value).padStart(6,'0')}`;
    const inserted = await client.query(
      `INSERT INTO production_orders(company_id, order_number, customer_id, customer_order_reference, component_name, part_number,
         drawing_number, drawing_revision, planned_quantity, unit, due_date, priority, machine_id, assigned_employee_id,
         job_id, instructions, created_by, updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14,$15,$16,$17,$17) RETURNING id`,
      [user.companyId, orderNumber, customerId, body.customerOrderReference ? String(body.customerOrderReference).trim().slice(0,120) : null,
        componentName, partNumber, body.drawingNumber ? String(body.drawingNumber).trim().slice(0,100) : null,
        body.drawingRevision ? String(body.drawingRevision).trim().slice(0,40) : null, quantity, unit, dueDate, priority,
        body.machineId ? String(body.machineId) : null, body.assignedEmployeeId || null, body.jobId || null,
        body.instructions ? String(body.instructions).trim().slice(0,5000) : null, user.id]
    );
    const orderId = inserted.rows[0].id;
    for (const [itemId, planned] of materialsById) {
      const selected = await client.query(`SELECT unit FROM inventory_items WHERE id::text=$1::text AND company_id::text=$2::text`, [itemId, user.companyId]);
      await client.query(`INSERT INTO production_order_materials(company_id,order_id,inventory_item_id,planned_quantity,unit,created_by) VALUES($1,$2,$3,$4,$5,$6)`, [user.companyId, orderId, itemId, planned, selected.rows[0]?.unit || null, user.id]);
    }
    await appendEvent(client, user, { orderId, type: 'order_created', toStatus: ORDER_STATUSES.PLANNED, quantity, details: { orderNumber } });
    const order = await client.query(`${ORDER_SELECT} AND o.id=$2`, [user.companyId, orderId]);
    return { order: mapOrder(order.rows[0]), assignedEmployeeId: body.assignedEmployeeId || null };
  });
  if (!created[REPLAYED] && created.assignedEmployeeId) {
    try { await createNotification({ user_id: created.assignedEmployeeId, company_id: user.companyId, type: 'production_assignment', title: 'Production order assigned', message: `${created.order.orderNumber}: ${created.order.componentName}`, priority: created.order.priority, data: { url: '/employee/production', production_order_id: created.order.id } }); } catch (err) { console.error('Production assignment notification failed:', err.message); }
  } else if (!created[REPLAYED]) {
    try { await createNotificationForOwners({ company_id: user.companyId, type: 'production_order_created', title: 'Production order created', message: `${created.order.orderNumber}: ${created.order.componentName}`, data: { url: '/owner/production', production_order_id: created.order.id }, exclude_user_id: user.id }); } catch (err) { console.error('Production order notification failed:', err.message); }
  }
  res.status(201).json({ success: true, data: { order: created.order } });
}));

router.post('/orders/:orderId/assignments', route(async (req) => {
  const user = principal(req); requireRole(user, OWNER_ROLES);
  const result = await mutate(req, `assign-production:${req.params.orderId}`, async (client) => {
    const order = await fetchOrder(client, req.params.orderId, user.companyId, true);
    const active = await client.query(`SELECT 1 FROM production_batches WHERE company_id::text=$1::text AND order_id=$2 AND status IN ('in_production','submitted') LIMIT 1`, [user.companyId,order.id]);
    if (active.rows.length) { const e = new Error('Assignment cannot change while a batch is active or awaiting inspection.'); e.status=409; throw e; }
    const employeeId = req.body?.assignedEmployeeId ? String(req.body.assignedEmployeeId) : null;
    const machineId = req.body?.machineId ? String(req.body.machineId) : null;
    if (employeeId) {
      const employee = await client.query(`SELECT id FROM users WHERE id::text=$1::text AND company_id::text=$2::text AND role IN ('employee','staff','technician') AND COALESCE(is_active,TRUE)=TRUE`, [employeeId,user.companyId]);
      if (!employee.rows.length) { const e = new Error('Assigned operator is not available in this company.'); e.status=400; throw e; }
    }
    if (machineId) {
      const machine = await client.query(`SELECT id FROM customer_machines WHERE id::text=$1::text AND company_id::text=$2::text AND COALESCE(status,'operational') <> 'decommissioned'`, [machineId,user.companyId]);
      if (!machine.rows.length) { const e = new Error('Machine is not available in this company.'); e.status=400; throw e; }
    }
    const reason = requireText(req.body?.reason, 'Assignment reason', 1000);
    await client.query(`UPDATE production_orders SET assigned_employee_id=$1,machine_id=$2,updated_by=$3,updated_at=NOW() WHERE id=$4 AND company_id::text=$5::text`, [employeeId,machineId,user.id,order.id,user.companyId]);
    await appendEvent(client,user,{orderId:order.id,type:'production_assignment_updated',reason,details:{previousEmployeeId:order.assigned_employee_id,assignedEmployeeId:employeeId,previousMachineId:order.machine_id,machineId}});
    const refreshed = await client.query(`${ORDER_SELECT} AND o.id=$2`,[user.companyId,order.id]);
    return { order: mapOrder(refreshed.rows[0]), assignedEmployeeId: employeeId };
  });
  if (!result[REPLAYED] && result.assignedEmployeeId) {
    try { await createNotification({ user_id: result.assignedEmployeeId, company_id: user.companyId, type: 'production_assignment', title: 'Production order assigned', message: `${result.order.orderNumber}: ${result.order.componentName}`, priority: result.order.priority, data: { url: '/employee/production', production_order_id: result.order.id } }); } catch (err) { console.error('Production assignment notification failed:', err.message); }
  }
  return { order: result.order };
}));

router.post('/orders/:orderId/start', route(async (req) => {
  const user = principal(req);
  return mutate(req, `start-production:${req.params.orderId}`, async (client) => {
    const order = await fetchOrder(client, req.params.orderId, user.companyId, true);
    const target = String(order.assigned_employee_id || '');
    if (EMPLOYEE_ROLES.has(user.role) && target !== user.id) { const e = new Error('This order is not assigned to you.'); e.status=403; throw e; }
    if (!EMPLOYEE_ROLES.has(user.role) && !OWNER_ROLES.has(user.role)) requireRole(user, OWNER_ROLES);
    if (OWNER_ROLES.has(user.role) && !order.assigned_employee_id) { const e = new Error('Assign an operator before starting production.'); e.status=409; throw e; }
    const active = await client.query(`SELECT id, started_at FROM production_batches WHERE company_id::text=$1::text AND order_id=$2 AND status IN ('in_production','submitted') ORDER BY started_at DESC LIMIT 1 FOR UPDATE`, [user.companyId, order.id]);
    if (active.rows.length) return { batchId: active.rows[0].id, startedAt: active.rows[0].started_at };
    const transition = assertStatusTransition({ fromStatus: order.status, toStatus: ORDER_STATUSES.IN_PRODUCTION, actorRole: EMPLOYEE_ROLES.has(user.role) ? 'employee' : user.role, actorId: user.id, assignedEmployeeId: order.assigned_employee_id });
    const latest = await client.query(`SELECT COALESCE(MAX(batch_number),0)::int AS n FROM production_batches WHERE company_id::text=$1::text AND order_id=$2`, [user.companyId, order.id]);
    const operatorId = target || user.id;
    const batch = await client.query(`INSERT INTO production_batches(company_id,order_id,batch_number,operator_id,machine_id,status) VALUES($1,$2,$3,$4,$5,'in_production') RETURNING id,started_at`, [user.companyId, order.id, latest.rows[0].n + 1, operatorId, order.machine_id]);
    await client.query(`UPDATE production_orders SET status=$1, updated_by=$2, updated_at=NOW() WHERE id=$3 AND company_id::text=$4::text`, [transition.toStatus, user.id, order.id, user.companyId]);
    await appendEvent(client, user, { orderId: order.id, batchId: batch.rows[0].id, type: 'production_started', fromStatus: order.status, toStatus: transition.toStatus, details: { operatorId } });
    return { batchId: batch.rows[0].id, startedAt: batch.rows[0].started_at };
  });
}));

router.post('/batches/:batchId/reports', route(async (req) => {
  const user = principal(req);
  return mutate(req, `production-report:${req.params.batchId}`, async (client) => {
    const batchResult = await client.query(`SELECT b.*, o.planned_quantity, o.status AS order_status, o.assigned_employee_id FROM production_batches b JOIN production_orders o ON o.id=b.order_id AND o.company_id::text=b.company_id::text WHERE b.id::text=$1::text AND b.company_id::text=$2::text FOR UPDATE OF b,o`, [req.params.batchId, user.companyId]);
    if (!batchResult.rows.length) { const e = new Error('Production batch was not found.'); e.status=404; throw e; }
    const batch = batchResult.rows[0];
    if ((!EMPLOYEE_ROLES.has(user.role) && !OWNER_ROLES.has(user.role)) || (EMPLOYEE_ROLES.has(user.role) && (String(batch.operator_id) !== user.id || String(batch.assigned_employee_id) !== user.id))) { const e = new Error('You are not authorized to report this production batch.'); e.status=403; throw e; }
    if (batch.status !== 'in_production') { const e = new Error('Only an active production batch accepts quantity reports.'); e.status=409; throw e; }
    const totals = await client.query(`SELECT COALESCE(SUM(good_quantity),0) AS good FROM production_reports WHERE company_id::text=$1::text AND order_id=$2`, [user.companyId, batch.order_id]);
    const rule = assertProductionReport({ plannedQuantity: batch.planned_quantity, priorGoodQuantity: totals.rows[0].good, goodQuantity: req.body?.goodQuantity, rejectedQuantity: req.body?.rejectedQuantity, reworkQuantity: req.body?.reworkQuantity });
    const actorName = await getActorName(client,user);
    const inserted = await client.query(`INSERT INTO production_reports(company_id,order_id,batch_id,reported_by,reported_by_name,good_quantity,rejected_quantity,rework_quantity,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,reported_at`, [user.companyId, batch.order_id, batch.id, user.id, actorName, rule.goodQuantity, rule.rejectedQuantity, rule.reworkQuantity, req.body?.notes ? String(req.body.notes).trim().slice(0,3000) : null]);
    await appendEvent(client, user, { orderId: batch.order_id, batchId: batch.id, type: 'production_quantity_reported', quantity: rule.attemptedQuantity, details: { good: rule.goodQuantity, rejected: rule.rejectedQuantity, rework: rule.reworkQuantity } });
    return { report: { id: inserted.rows[0].id, reportedAt: inserted.rows[0].reported_at } };
  });
}));

router.post('/batches/:batchId/submit-quality', route(async (req) => {
  const user = principal(req);
  return mutate(req, `submit-quality:${req.params.batchId}`, async (client) => {
    const result = await client.query(`SELECT b.*, o.status AS order_status, o.assigned_employee_id FROM production_batches b JOIN production_orders o ON o.id=b.order_id AND o.company_id::text=b.company_id::text WHERE b.id::text=$1::text AND b.company_id::text=$2::text FOR UPDATE OF b,o`, [req.params.batchId, user.companyId]);
    if (!result.rows.length) { const e = new Error('Production batch was not found.'); e.status=404; throw e; }
    const batch = result.rows[0];
    if (!EMPLOYEE_ROLES.has(user.role) || String(batch.operator_id) !== user.id || String(batch.assigned_employee_id) !== user.id) { const e = new Error('Only the assigned operator can submit this batch.'); e.status=403; throw e; }
    const totals = await client.query(`SELECT COALESCE(SUM(good_quantity+rejected_quantity+rework_quantity),0) AS submitted FROM production_reports WHERE company_id::text=$1::text AND batch_id=$2`, [user.companyId, batch.id]);
    const submitted = Number(totals.rows[0].submitted);
    if (submitted <= 0) { const e = new Error('Record production quantities before submitting for inspection.'); e.status=409; throw e; }
    if (batch.status === 'submitted') return { submittedAt: batch.submitted_at };
    if (batch.status !== 'in_production') { const e = new Error('This batch cannot be submitted for inspection.'); e.status=409; throw e; }
    const transition = assertStatusTransition({ fromStatus: batch.order_status, toStatus: ORDER_STATUSES.QUALITY_CHECK, actorRole: 'employee', actorId: user.id, assignedEmployeeId: batch.assigned_employee_id, hasProductionReport: true });
    const updated = await client.query(`UPDATE production_batches SET status='submitted', submitted_at=NOW() WHERE id=$1 AND company_id::text=$2::text RETURNING submitted_at`, [batch.id, user.companyId]);
    await client.query(`UPDATE production_orders SET status=$1, updated_by=$2, updated_at=NOW() WHERE id=$3 AND company_id::text=$4::text`, [transition.toStatus, user.id, batch.order_id, user.companyId]);
    await appendEvent(client, user, { orderId: batch.order_id, batchId: batch.id, type: 'quality_inspection_requested', fromStatus: batch.order_status, toStatus: transition.toStatus, quantity: submitted });
    return { submittedAt: updated.rows[0].submitted_at };
  });
}));

router.post('/batches/:batchId/inspections', route(async (req) => {
  const user = principal(req); requireRole(user, INSPECTOR_ROLES);
  const response = await mutate(req, `inspect-batch:${req.params.batchId}`, async (client) => {
    const result = await client.query(`SELECT b.*, o.status AS order_status, o.order_number FROM production_batches b JOIN production_orders o ON o.id=b.order_id AND o.company_id::text=b.company_id::text WHERE b.id::text=$1::text AND b.company_id::text=$2::text FOR UPDATE OF b,o`, [req.params.batchId, user.companyId]);
    if (!result.rows.length) { const e = new Error('Production batch was not found.'); e.status=404; throw e; }
    const batch = result.rows[0];
    if (batch.status !== 'submitted') { const e = new Error('Only a submitted batch can be inspected.'); e.status=409; throw e; }
    const sum = await client.query(`SELECT COALESCE(SUM(good_quantity+rejected_quantity+rework_quantity),0) submitted FROM production_reports WHERE company_id::text=$1::text AND batch_id=$2`, [user.companyId, batch.id]);
    const outcome = assertQualityOutcome({ submittedQuantity: sum.rows[0].submitted, acceptedQuantity: req.body?.acceptedQuantity, rejectedQuantity: req.body?.rejectedQuantity, reworkQuantity: req.body?.reworkQuantity, reason: req.body?.reason });
    const seq = await client.query(`SELECT COUNT(*)::int n FROM production_inspections WHERE company_id::text=$1::text AND batch_id=$2`, [user.companyId, batch.id]);
    const reference = `QC-${batch.order_number}-${String(seq.rows[0].n + 1).padStart(2,'0')}`;
    const inspectorName = await getActorName(client,user);
    const measurements = Array.isArray(req.body?.measurements) ? req.body.measurements.slice(0,100) : [];
    if (JSON.stringify(measurements).length > 20000) { const e = new Error('Inspection measurements are too large.'); e.status=400; throw e; }
    const inserted = await client.query(`INSERT INTO production_inspections(company_id,order_id,batch_id,inspector_id,inspector_name,inspection_reference,submitted_quantity,accepted_quantity,rejected_quantity,rework_quantity,result,reason,notes,measurements) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING id,inspected_at`, [user.companyId, batch.order_id, batch.id, user.id, inspectorName, reference, outcome.submittedQuantity, outcome.acceptedQuantity, outcome.rejectedQuantity, outcome.reworkQuantity, outcome.result, req.body?.reason ? String(req.body.reason).trim().slice(0,2000) : null, req.body?.notes ? String(req.body.notes).trim().slice(0,3000) : null, JSON.stringify(measurements)]);
    await client.query(`UPDATE production_batches SET status='inspected', completed_at=NOW() WHERE id=$1 AND company_id::text=$2::text`, [batch.id, user.companyId]);
    const nextStatus = outcome.reworkQuantity > 0 ? ORDER_STATUSES.REWORK_REQUIRED : outcome.acceptedQuantity > 0 ? ORDER_STATUSES.READY_FOR_DISPATCH : ORDER_STATUSES.REJECTED;
    await client.query(`UPDATE production_orders SET status=$1, updated_by=$2, updated_at=NOW() WHERE id=$3 AND company_id::text=$4::text`, [nextStatus, user.id, batch.order_id, user.companyId]);
    await appendEvent(client, user, { orderId: batch.order_id, batchId: batch.id, type: 'quality_inspection_completed', fromStatus: batch.order_status, toStatus: nextStatus, quantity: outcome.acceptedQuantity, reason: req.body?.reason || null, details: outcome });
    return { inspection: { id: inserted.rows[0].id, reference, inspectedAt: inserted.rows[0].inspected_at, ...outcome } };
  });
  const batch = await pool.query(`SELECT o.assigned_employee_id,o.order_number FROM production_batches b JOIN production_orders o ON o.id=b.order_id AND o.company_id::text=b.company_id::text WHERE b.id::text=$1::text AND b.company_id::text=$2::text`, [req.params.batchId, user.companyId]).catch(() => ({ rows: [] }));
  if (!response[REPLAYED] && batch.rows[0]?.assigned_employee_id) {
    try { await createNotification({ user_id: batch.rows[0].assigned_employee_id, company_id: user.companyId, type: 'production_quality_result', title: 'Quality inspection completed', message: `${batch.rows[0].order_number} inspection result: ${response.inspection.result}`, data: { url: '/employee/production' } }); } catch (err) { console.error('Production quality notification failed:', err.message); }
  }
  return response;
}));

router.post('/orders/:orderId/dispatches', route(async (req) => {
  const user = principal(req); requireRole(user, OWNER_ROLES);
  const response = await mutate(req, `dispatch-order:${req.params.orderId}`, async (client) => {
    if (req.body?.confirmed !== true) { const e = new Error('Explicit dispatch confirmation is required.'); e.status=400; throw e; }
    const order = await fetchOrder(client, req.params.orderId, user.companyId, true);
    const totals = await client.query(`SELECT COALESCE((SELECT SUM(accepted_quantity) FROM production_inspections WHERE company_id::text=$1::text AND order_id=$2),0) accepted, COALESCE((SELECT SUM(quantity) FROM production_dispatches WHERE company_id::text=$1::text AND order_id=$2),0) dispatched, COALESCE((SELECT SUM(quantity_delta) FROM production_dispatch_adjustments WHERE company_id::text=$1::text AND order_id=$2),0) adjustments`, [user.companyId, order.id]);
    const t = totals.rows[0];
    const check = assertDispatchQuantity({ acceptedQuantity: t.accepted, previouslyDispatchedQuantity: Number(t.dispatched) + Number(t.adjustments), requestedQuantity: req.body?.quantity });
    const year = (await client.query(`SELECT EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Asia/Kolkata')::int year`)).rows[0].year;
    const sequence = await client.query(`INSERT INTO production_sequences(company_id,sequence_kind,sequence_year,next_value) VALUES($1,'dispatch',$2,1) ON CONFLICT(company_id,sequence_kind,sequence_year) DO UPDATE SET next_value=production_sequences.next_value+1 RETURNING next_value`, [user.companyId, year]);
    const reference = `DSP-${year}-${String(sequence.rows[0].next_value).padStart(6,'0')}`;
    const confirmedByName = await getActorName(client,user);
    const inserted = await client.query(`INSERT INTO production_dispatches(company_id,order_id,dispatch_reference,quantity,delivery_reference,carrier,transport_details,notes,confirmed_by,confirmed_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,quantity,dispatched_at`, [user.companyId, order.id, reference, check.requestedQuantity, req.body?.deliveryReference ? String(req.body.deliveryReference).trim().slice(0,120) : null, req.body?.carrier ? String(req.body.carrier).trim().slice(0,120) : null, req.body?.transportDetails ? String(req.body.transportDetails).trim().slice(0,1000) : null, req.body?.notes ? String(req.body.notes).trim().slice(0,2000) : null, user.id, confirmedByName]);
    const nextStatus = deriveDispatchStatus({ acceptedQuantity: t.accepted, dispatchedQuantity: Number(t.dispatched) + Number(t.adjustments) + check.requestedQuantity });
    await client.query(`UPDATE production_orders SET status=$1,updated_by=$2,updated_at=NOW() WHERE id=$3 AND company_id::text=$4::text`, [nextStatus, user.id, order.id, user.companyId]);
    await appendEvent(client, user, { orderId: order.id, type: 'dispatch_confirmed', fromStatus: order.status, toStatus: nextStatus, quantity: check.requestedQuantity, details: { reference } });
    return { dispatch: { id: inserted.rows[0].id, reference, quantity: Number(inserted.rows[0].quantity), dispatchedAt: inserted.rows[0].dispatched_at, remainingAcceptedQuantity: check.remainingDispatchableQuantity } };
  });
  const assigned = await pool.query(`SELECT assigned_employee_id FROM production_orders WHERE id::text=$1::text AND company_id::text=$2::text`, [req.params.orderId, user.companyId]).catch(() => ({ rows: [] }));
  if (!response[REPLAYED] && assigned.rows[0]?.assigned_employee_id) {
    try { await createNotification({ user_id: assigned.rows[0].assigned_employee_id, company_id: user.companyId, type: 'production_dispatch_confirmed', title: 'Production dispatch confirmed', message: `Dispatch ${response.dispatch.reference} has been confirmed.`, data: { url: '/employee/production' } }); } catch (err) { console.error('Production dispatch notification failed:', err.message); }
  }
  return response;
}));

router.post('/dispatches/:dispatchId/corrections', route(async (req) => {
  const user = principal(req); requireRole(user, OWNER_ROLES);
  return mutate(req, `correct-dispatch:${req.params.dispatchId}`, async (client) => {
    const reason = requireText(req.body?.reason, 'Correction reason', 2000);
    const delta = Number(req.body?.quantityDelta);
    if (!Number.isFinite(delta) || delta === 0 || Math.round(delta * 1000) !== delta * 1000) { const e = new Error('Correction quantity must be non-zero with at most three decimal places.'); e.status=400; throw e; }
    const dispatch = await client.query(`SELECT d.*,o.status FROM production_dispatches d JOIN production_orders o ON o.id=d.order_id AND o.company_id::text=d.company_id::text WHERE d.id::text=$1::text AND d.company_id::text=$2::text FOR UPDATE OF d,o`, [req.params.dispatchId,user.companyId]);
    if (!dispatch.rows.length) { const e = new Error('Dispatch was not found.'); e.status=404; throw e; }
    const record = dispatch.rows[0];
    const totals = await client.query(`SELECT COALESCE((SELECT SUM(accepted_quantity) FROM production_inspections WHERE company_id::text=$1::text AND order_id=$2),0) accepted, COALESCE((SELECT SUM(quantity) FROM production_dispatches WHERE company_id::text=$1::text AND order_id=$2),0) dispatched, COALESCE((SELECT SUM(quantity_delta) FROM production_dispatch_adjustments WHERE company_id::text=$1::text AND order_id=$2),0) adjustments`, [user.companyId,record.order_id]);
    const after = Number(totals.rows[0].dispatched)+Number(totals.rows[0].adjustments)+delta;
    if (after < 0 || after - Number(totals.rows[0].accepted) > 0.000001) { const e = new Error('Correction would make dispatched quantity negative or greater than released quantity.'); e.status=409; throw e; }
    const inserted = await client.query(`INSERT INTO production_dispatch_adjustments(company_id,dispatch_id,order_id,quantity_delta,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at`, [user.companyId,record.id,record.order_id,delta,reason,user.id]);
    const next = deriveDispatchStatus({ acceptedQuantity: totals.rows[0].accepted, dispatchedQuantity: after });
    await client.query(`UPDATE production_orders SET status=COALESCE($1,status),updated_by=$2,updated_at=NOW() WHERE id=$3 AND company_id::text=$4::text`, [next,user.id,record.order_id,user.companyId]);
    await appendEvent(client,user,{orderId:record.order_id,type:'dispatch_corrected',fromStatus:record.status,toStatus:next,quantity:delta,reason,details:{dispatchId:record.id,dispatchReference:record.dispatch_reference}});
    return { correction: { id: inserted.rows[0].id, quantityDelta: delta, reason, createdAt: inserted.rows[0].created_at } };
  });
}));

module.exports = router;
