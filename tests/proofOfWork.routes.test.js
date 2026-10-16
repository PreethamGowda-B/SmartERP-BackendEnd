const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const routePath = path.join(__dirname, '..', 'routes', 'proofOfWork.js');
const jobId = 'a8c96b23-475e-46dc-a0d6-32515ad3daaf';
const companyId = '42';

function loadRouter({ pool, notifications = [] }) {
  delete require.cache[routePath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === routePath) {
      if (request === '../db') return { pool };
      if (request === '../middleware/authMiddleware') return { authenticateToken: (_req, _res, next) => next() };
      if (request === '../middleware/attendanceGatekeeperMiddleware') return { requireClockIn: (_req, _res, next) => next() };
      if (request === '../utils/notificationHelpers') return {
        createNotification: async () => {},
        createNotificationForOwners: async (notification) => {
          notifications.push(notification);
          pool.calls.push('notification created');
        },
      };
      if (request === '../services/eventMessagingService') return { onProofUploaded: async () => {} };
      if (request === '../middleware/als') return { storage: { run: (_context, callback) => callback() } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(routePath);
  } finally {
    Module._load = originalLoad;
  }
}

function handler(router, method, endpoint) {
  const routeLayer = router.stack.find((layer) => layer.route?.path === endpoint && layer.route?.methods?.[method]);
  assert.ok(routeLayer, `${method.toUpperCase()} ${endpoint} route exists`);
  return routeLayer.route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function basePool({ company = companyId, insertRows = null, failProofRead = false, proofRows = [] } = {}) {
  const calls = [];
  const proof = {
    id: 17,
    job_id: jobId,
    company_id: companyId,
    uploaded_by_id: 'employee-7',
    photo_url: null,
    notes: 'Checked the machine',
    stage: 'in_progress',
    created_at: new Date().toISOString(),
  };
  const pool = {
    calls,
    async connect() {
      return { query: async (sql) => { calls.push(sql); return { rows: [] }; }, release() {} };
    },
    async query(sql, params = []) {
      calls.push(sql);
      if (sql.includes('FROM jobs WHERE id::text') && sql.includes('company_id::text = $2::text')) {
        if (String(params[1]) !== String(company)) return { rows: [] };
        return { rows: [{ id: jobId, machine_id: null, title: 'Test job', company_id: companyId, assigned_to: 'employee-7' }] };
      }
      if (sql.includes('INSERT INTO job_proof_of_work')) return { rows: insertRows === null ? [proof] : insertRows };
      if (sql.includes('client_submission_id')) return { rows: [proof] };
      if (sql.includes('WHERE id = $1 AND job_id')) return { rows: [proof] };
      if (sql.includes('FROM jobs WHERE id::text = $1::text') && !sql.includes('company_id::text = $2::text')) return { rows: [{ id: jobId, company_id: companyId, customer_id: null }] };
      if (sql.includes('FROM job_proof_of_work')) {
        if (failProofRead) throw new Error('permission denied for job_proof_of_work');
        return { rows: proofRows };
      }
      return { rows: [] };
    },
  };
  return { pool, proof };
}

function postRequest(body = {}) {
  return {
    params: { id: jobId },
    body: { notes: 'Checked the machine', stage: 'in_progress', ...body },
    user: { id: 'employee-7', userId: 'employee-7', name: 'Technician', role: 'employee', companyId },
  };
}

test('proof submission verifies the persisted row before notifying owners', async () => {
  const notifications = [];
  const { pool } = basePool();
  const router = loadRouter({ pool, notifications });
  const res = response();

  await handler(router, 'post', '/:id/proof-of-work')(postRequest({ client_submission_id: 'request-1' }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.proof.id, 17);
  assert.ok(pool.calls.findIndex((sql) => sql.includes('WHERE id = $1 AND job_id')) < pool.calls.indexOf('notification created'));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].data.job_id, jobId);
  assert.equal(notifications[0].data.proof_id, 17);
  assert.equal(notifications[0].data.url, `/owner/jobs/${jobId}`);
});

test('a retry with the same submission ID does not create a second proof or notification', async () => {
  const notifications = [];
  const { pool } = basePool({ insertRows: [] });
  const router = loadRouter({ pool, notifications });
  const res = response();

  await handler(router, 'post', '/:id/proof-of-work')(postRequest({ client_submission_id: 'request-1' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(notifications.length, 0);
});

test('proof submission rejects jobs outside the caller company', async () => {
  const { pool } = basePool({ company: '99' });
  const router = loadRouter({ pool });
  const res = response();

  await handler(router, 'post', '/:id/proof-of-work')(postRequest(), res);

  assert.equal(res.statusCode, 404);
  assert.equal(pool.calls.some((sql) => sql.includes('INSERT INTO job_proof_of_work')), false);
});

test('proof reads report database errors instead of returning a false empty result', async () => {
  const { pool } = basePool({ failProofRead: true });
  const router = loadRouter({ pool });
  const req = { params: { id: jobId }, proofCaller: { id: 'owner-1', companyId, role: 'owner' } };
  const res = response();
  const originalConsoleError = console.error;

  console.error = () => {};
  try {
    await handler(router, 'get', '/:id/proof-of-work')(req, res);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(Object.hasOwn(res.body, 'proofs'), false);
});

test('authorized owners can retrieve the saved proof under the job company', async () => {
  const savedProof = { id: 17, job_id: jobId, company_id: companyId, photo_url: null, notes: 'Saved proof' };
  const { pool } = basePool({ proofRows: [savedProof] });
  const router = loadRouter({ pool });
  const req = { params: { id: jobId }, proofCaller: { id: 'owner-1', companyId, role: 'owner' } };
  const res = response();

  await handler(router, 'get', '/:id/proof-of-work')(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.proofs, [savedProof]);
  assert.ok(pool.calls.some((sql) => sql.includes('company_id::text = $2::text')));
});

test('customers cannot retrieve another customer’s proof in the same company', async () => {
  const { pool } = basePool();
  const router = loadRouter({ pool });
  const req = { params: { id: jobId }, proofCaller: { id: 'customer-9', companyId, role: 'customer' } };
  const res = response();

  await handler(router, 'get', '/:id/proof-of-work')(req, res);

  assert.equal(res.statusCode, 403);
});

test('proof upload rejects invalid image signatures before writing', async () => {
  const { pool } = basePool();
  const router = loadRouter({ pool });
  const res = response();
  const invalidImage = 'data:image/jpeg;base64,' + Buffer.from('not an image').toString('base64');

  await handler(router, 'post', '/:id/proof-of-work')(postRequest({ photo_url: invalidImage }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(pool.calls.some((sql) => sql.includes('INSERT INTO job_proof_of_work')), false);
});

test('proof upload rejects images larger than 5 MB before writing', async () => {
  const { pool } = basePool();
  const router = loadRouter({ pool });
  const res = response();
  const oversizedImage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]);

  await handler(router, 'post', '/:id/proof-of-work')(
    postRequest({ photo_url: `data:image/jpeg;base64,${oversizedImage.toString('base64')}` }),
    res,
  );

  assert.equal(res.statusCode, 413);
  assert.equal(pool.calls.some((sql) => sql.includes('INSERT INTO job_proof_of_work')), false);
});
