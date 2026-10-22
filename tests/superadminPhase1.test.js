'use strict';

process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const activitiesRouter = require('../routes/activities');
const healthRouter = require('../routes/superadminHealth');
const adminRouter = require('../routes/admin');
const feedbackRouter = require('../routes/feedback');
const { pool } = require('../db');
const { authenticateSuperAdmin } = require('../middleware/adminMiddleware');

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function routeHandler(router, method, path) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `${method.toUpperCase()} ${path} route exists`);
  return route.route.stack.at(-1).handle;
}

test('tenant activity reader requires company context without a default tenant', async () => {
  let queried = false;
  const handler = activitiesRouter.createActivityReadHandler(async () => { queried = true; return { rows: [] }; });
  const res = response();

  await handler({ user: { role: 'employee' } }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(queried, false);
});

test('tenant activity query is scoped by the authenticated company', async () => {
  let sql;
  let params;
  const handler = activitiesRouter.createActivityReadHandler(async (query, values) => {
    sql = query;
    params = values;
    return { rows: [{ id: 1 }] };
  });
  const res = response();

  await handler({ user: { role: 'employee', companyId: 'company-b' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(params, ['company-b']);
  assert.match(sql, /a\.company_id::text = \$1::text/);
  assert.match(sql, /u\.company_id::text = \$1::text/);
  assert.match(sql, /scoped_user\.company_id::text = \$1::text/);
  assert.deepEqual(res.body.activities, [{ id: 1 }]);
});

test('Super Admin company deletion remains blocked pending retention policy', async () => {
  const res = response();
  await routeHandler(adminRouter, 'delete', '/companies/:id')({ params: { id: 'company-1' }, body: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'COMPANY_RETENTION_POLICY_REQUIRED');
});

test('company status rejects unsupported values before touching storage', async () => {
  const originalQuery = pool.query;
  let queried = false;
  pool.query = async () => { queried = true; throw new Error('should not query'); };
  const res = response();
  try {
    await routeHandler(adminRouter, 'patch', '/companies/:id/status')({ params: { id: 'c1' }, body: { status: 'deleted' } }, res);
  } finally {
    pool.query = originalQuery;
  }
  assert.equal(res.statusCode, 400);
  assert.equal(queried, false);
});

test('staff mutations require explicit account_type before touching storage', async () => {
  const originalQuery = pool.query;
  let queried = false;
  pool.query = async () => { queried = true; throw new Error('should not query'); };
  const res = response();
  try {
    await routeHandler(adminRouter, 'patch', '/users/:id')({ params: { id: 'same-id' }, query: {}, body: { role: 'owner' } }, res);
  } finally {
    pool.query = originalQuery;
  }
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'ACCOUNT_TYPE_REQUIRED');
  assert.equal(queried, false);
});

test('announcement history selects announcement records with pagination', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return calls.length === 1
      ? { rows: [{ id: 'a1' }] }
      : { rows: [{ total: '1' }] };
  };
  const res = response();
  try {
    await routeHandler(adminRouter, 'get', '/announcements')({ query: { page: '2', limit: '10' } }, res);
  } finally {
    pool.query = originalQuery;
  }
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.announcements, [{ id: 'a1' }]);
  assert.deepEqual(calls[0].params, [10, 10]);
  assert.match(calls[0].sql, /FROM announcements/);
  assert.match(calls[1].sql, /COUNT\(\*\).*FROM announcements/s);
});

test('maintenance reads and writes fail clearly when schema is absent without request-time DDL', async () => {
  const originalQuery = pool.query;
  const statements = [];
  pool.query = async (sql) => {
    statements.push(sql);
    const error = new Error('relation system_settings does not exist');
    error.code = '42P01';
    throw error;
  };
  const getRes = response();
  const postRes = response();
  try {
    await routeHandler(adminRouter, 'get', '/system/status')({ query: {} }, getRes);
    await routeHandler(adminRouter, 'post', '/system/maintenance')({ body: { mode: 'enabled' }, user: { email: 'admin@example.test' } }, postRes);
  } finally {
    pool.query = originalQuery;
  }
  assert.equal(getRes.statusCode, 503);
  assert.equal(getRes.body.code, 'MAINTENANCE_SCHEMA_NOT_READY');
  assert.equal(postRes.statusCode, 503);
  assert.equal(postRes.body.code, 'MAINTENANCE_SCHEMA_NOT_READY');
  assert.ok(statements.every((sql) => !/CREATE\s+TABLE/i.test(sql)));
});

test('announcement persistence is atomic, targets active owners, and replays without duplicate notifications', async () => {
  const originalConnect = pool.connect;
  let fingerprint = null;
  const notificationWrites = [];
  const statements = [];
  pool.connect = async () => ({
    query: async (sql, params = []) => {
      statements.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT pg_advisory')) return { rows: [] };
      if (sql.includes("SELECT data->>'request_fingerprint'")) {
        return { rows: fingerprint ? [{ fingerprint }] : [] };
      }
      if (sql.includes("SELECT id, company_id FROM users")) return { rows: [{ id: 'owner-1', company_id: 'company-1' }, { id: 'owner-2', company_id: 'company-2' }] };
      if (sql.includes('INSERT INTO announcements')) return { rows: [{ id: 'announcement-1' }] };
      if (sql.includes('INSERT INTO notifications')) {
        notificationWrites.push(params);
        fingerprint = JSON.parse(params[4]).request_fingerprint;
        return { rows: [] };
      }
      throw new Error('Unexpected mock query');
    },
    release() {},
  });
  const handler = routeHandler(adminRouter, 'post', '/announcements');
  const makeRequest = (message) => ({
    user: { id: 'superadmin-1' },
    body: { title: 'Service update', message, priority: 'medium', idempotency_key: 'broadcast-001' },
  });
  const first = response();
  const replay = response();
  try {
    await handler(makeRequest('Planned update'), first);
    await handler(makeRequest('Planned update'), replay);
  } finally {
    pool.connect = originalConnect;
  }
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.sent, 2);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(notificationWrites.length, 2);
  assert.ok(statements.includes('COMMIT'));
});

test('announcement schema errors return unavailable and roll back instead of reporting success', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  pool.connect = async () => ({
    query: async (sql) => {
      statements.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT pg_advisory')) return { rows: [] };
      if (sql.includes("SELECT data->>'request_fingerprint'")) {
        const error = new Error('column idempotency_key does not exist');
        error.code = '42703';
        throw error;
      }
      throw new Error('Unexpected mock query');
    },
    release() {},
  });
  const res = response();
  const handler = routeHandler(adminRouter, 'post', '/announcements');
  try {
    await handler({ user: { id: 'superadmin-1' }, body: { message: 'Update', idempotency_key: 'broadcast-002' } }, res);
  } finally {
    pool.connect = originalConnect;
  }
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'ANNOUNCEMENT_SCHEMA_NOT_READY');
  assert.ok(statements.includes('ROLLBACK'));
  assert.ok(!statements.includes('COMMIT'));
});

test('feedback reply does not mark replied when email is explicitly rejected', async () => {
  const statements = [];
  const db = { query: async (sql) => {
    statements.push(sql);
    if (sql.startsWith('SELECT')) return { rows: [{ id: 'f1', user_id: 'u1', user_email: 'user@example.test', status: 'open', subject: 'Issue', message: 'Help' }] };
    if (sql.includes("SET status = 'in_progress'")) return { rows: [{ id: 'f1' }] };
    if (sql.includes('SET status = $1, admin_reply = NULL')) return { rows: [{ id: 'f1' }] };
    throw new Error('Unexpected query');
  } };
  const handler = feedbackRouter.createFeedbackReplyHandler({
    db,
    sendEmail: async () => { const error = new Error('rejected'); error.providerRejected = true; throw error; },
  });
  const res = response();
  await handler({ params: { id: 'f1' }, body: { replyMessage: 'We are checking.' } }, res);
  assert.equal(res.statusCode, 502);
  assert.ok(statements.some((sql) => sql.includes('admin_reply = NULL')));
  assert.ok(!statements.some((sql) => sql.includes("SET status = 'replied'")));
});

test('uncertain feedback email stays pending and retry does not send another message', async () => {
  let emailAttempts = 0;
  let pending = false;
  const db = { query: async (sql) => {
    if (sql.startsWith('SELECT')) return { rows: [{ id: 'f2', user_id: 'u2', user_email: 'user@example.test', status: pending ? 'in_progress' : 'open', admin_reply: pending ? 'We are checking.' : null }] };
    if (sql.includes("SET status = 'in_progress'")) {
      if (pending) return { rows: [] };
      pending = true;
      return { rows: [{ id: 'f2' }] };
    }
    throw new Error('Unexpected query');
  } };
  const handler = feedbackRouter.createFeedbackReplyHandler({ db, sendEmail: async () => { emailAttempts += 1; throw new Error('network timeout'); } });
  const first = response();
  await handler({ params: { id: 'f2' }, body: { replyMessage: 'We are checking.' } }, first);
  const retry = response();
  await handler({ params: { id: 'f2' }, body: { replyMessage: 'We are checking.' } }, retry);
  assert.equal(first.statusCode, 503);
  assert.equal(retry.statusCode, 409);
  assert.equal(emailAttempts, 1);
});

test('Super Admin cannot use the tenant activity endpoint for global history', async () => {
  let queried = false;
  const handler = activitiesRouter.createActivityReadHandler(async () => { queried = true; return { rows: [] }; });
  const res = response();

  await handler({ user: { role: 'super_admin' } }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(queried, false);
});

test('health metrics route includes token authentication and the platform Super Admin guard', () => {
  const route = healthRouter.stack.find((layer) => layer.route?.path === '/');
  assert.ok(route);
  assert.equal(route.route.stack.length, 3);
  assert.equal(route.route.stack[1].handle, authenticateSuperAdmin);
});

test('Super Admin middleware rejects ordinary authenticated roles', () => {
  const originalEmail = process.env.SUPER_ADMIN_EMAIL;
  delete process.env.SUPER_ADMIN_EMAIL;
  const emitter = require('../utils/securityEmitter');
  const originalEmit = emitter.emitSecurityEvent;
  emitter.emitSecurityEvent = () => {};
  const res = response();

  try {
    authenticateSuperAdmin({ user: { id: 'employee-1', role: 'employee' }, method: 'GET', path: '/health', ip: '127.0.0.1' }, res, () => {
      assert.fail('ordinary role must not be authorized');
    });
  } finally {
    emitter.emitSecurityEvent = originalEmit;
    if (originalEmail !== undefined) process.env.SUPER_ADMIN_EMAIL = originalEmail;
  }

  assert.equal(res.statusCode, 403);
});

test('global feedback statistics and reply use the shared Super Admin policy', () => {
  for (const [method, path] of [['get', '/stats'], ['patch', '/:id/reply']]) {
    const route = feedbackRouter.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
    assert.ok(route);
    assert.equal(route.route.stack[1].handle, authenticateSuperAdmin);
  }
});

test('configured platform-admin email exception is available through the protected access route', () => {
  const originalEmail = process.env.SUPER_ADMIN_EMAIL;
  process.env.SUPER_ADMIN_EMAIL = 'platform@example.test';
  const route = adminRouter.stack.find((layer) => layer.route?.path === '/access');
  assert.ok(route);
  const res = response();
  const req = { user: { role: 'owner', email: 'PLATFORM@example.test' } };

  try {
    authenticateSuperAdmin(req, res, () => route.route.stack[0].handle(req, res));
  } finally {
    if (originalEmail === undefined) delete process.env.SUPER_ADMIN_EMAIL;
    else process.env.SUPER_ADMIN_EMAIL = originalEmail;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.authorized, true);
});

test('health output contains measured counts and marks unmeasured service values unavailable', async () => {
  let currentTime = 100;
  const handler = healthRouter.createHealthMetricsHandler({
    query: async (sql) => {
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      return { rows: [{ count: '7' }] };
    },
    now: () => { currentTime += 25; return currentTime; },
    memoryUsage: () => ({ heapUsed: 1024 * 1024, heapTotal: 2 * 1024 * 1024, rss: 3 * 1024 * 1024 }),
    uptime: () => 42,
    operatingSystem: {
      freemem: () => 8 * 1024 * 1024,
      totalmem: () => 16 * 1024 * 1024,
      type: () => 'TestOS',
      platform: () => 'test',
      cpus: () => [1, 2],
    },
  });
  const res = response();

  await handler({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.health.db_latency_ms, 25);
  assert.equal(res.body.health.active_users, 7);
  assert.equal(res.body.health.active_sse_connections, null);
  assert.equal(res.body.health.notification_delivery_rate, null);
  assert.equal(res.body.health.ai_request_success_rate, null);
  assert.equal(res.body.health.status, 'degraded');
  assert.ok(res.body.health.unavailable_metrics.includes('active_sse_connections'));
});

test('health database failure returns unavailable rather than a healthy payload', async () => {
  const handler = healthRouter.createHealthMetricsHandler({ query: async () => { throw new Error('database unavailable'); } });
  const res = response();
  const originalError = console.error;
  console.error = () => {};

  try {
    await handler({}, res);
  } finally {
    console.error = originalError;
  }

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
  assert.equal(res.body.health.status, 'unavailable');
  assert.equal(res.body.health.db_latency_ms, null);
});
