const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pool } = require('../db');
const { checkPlanLimit } = require('../middleware/planMiddleware');
const { redisClient } = require('../utils/redis');

test.after(() => { redisClient?.disconnect(); });

function createLockManager() {
  const locks = new Map();
  return {
    async acquire(key) {
      const current = locks.get(key) || Promise.resolve();
      let release;
      const next = new Promise((resolve) => { release = resolve; });
      locks.set(key, current.then(() => next));
      await current;
      return () => {
        release();
        if (locks.get(key) === next) locks.delete(key);
      };
    }
  };
}

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = (statusCode) => { res.statusCode = statusCode; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('inventory plan quota rejects a direct create when the company is at its limit', async () => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  let count = 3;
  pool.query = async (sql) => {
    assert.match(sql, /COUNT\(\*\).*inventory_items/s);
    return { rows: [{ count }] };
  };
  pool.connect = async () => ({ query: async () => ({}), release() {} });
  try {
    const req = { user: { companyId: 'company-a' }, plan: { id: 1, name: 'Starter', max_inventory_items: 3 } };
    const res = response();
    let nextCalled = false;
    await checkPlanLimit('inventory')(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'PLAN_LIMIT_REACHED');
    assert.equal(nextCalled, false);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test('concurrent inventory creates serialize so the final seat cannot be exceeded', async () => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  let count = 0;
  const locks = createLockManager();
  pool.query = async (sql) => {
    assert.match(sql, /COUNT\(\*\).*inventory_items/s);
    return { rows: [{ count }] };
  };
  pool.connect = async () => {
    let releaseLock;
    return {
      async query(sql, params) {
        if (sql.includes('pg_advisory_lock')) releaseLock = await locks.acquire(String(params[0]) + String(params[1]));
        if (sql.includes('pg_advisory_unlock')) releaseLock?.();
        return {};
      },
      release() {}
    };
  };

  const create = async () => {
    const req = { user: { companyId: 'company-a' }, plan: { id: 1, name: 'Starter', max_inventory_items: 1 } };
    const res = response();
    await checkPlanLimit('inventory')(req, res, () => {
      count += 1; // The simulated API write occurs while the middleware lock is held.
      res.emit('finish');
    });
    return res.statusCode;
  };

  try {
    const statuses = await Promise.all([create(), create()]);
    assert.deepEqual(statuses.sort(), [200, 403]);
    assert.equal(count, 1);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test('storage quota includes the incoming file size', async () => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  pool.query = async (sql) => {
    assert.match(sql, /SUM\(file_size_bytes\).*company_storage_usage/s);
    return { rows: [{ bytes: '8' }] };
  };
  pool.connect = async () => ({ query: async () => ({}), release() {} });
  try {
    const req = { user: { companyId: 'company-a' }, plan: { id: 1, name: 'Starter', max_storage_bytes: 10 }, file: { size: 3 } };
    const res = response();
    let nextCalled = false;
    await checkPlanLimit('storage', { getRequestedUsage: (request) => request.file.size })(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'PLAN_LIMIT_REACHED');
    assert.equal(nextCalled, false);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test('concurrent file uploads serialize so combined bytes cannot exceed storage quota', async () => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  let storedBytes = 0;
  const locks = createLockManager();
  pool.query = async (sql) => {
    assert.match(sql, /SUM\(file_size_bytes\).*company_storage_usage/s);
    return { rows: [{ bytes: String(storedBytes) }] };
  };
  pool.connect = async () => {
    let releaseLock;
    return {
      async query(sql, params) {
        if (sql.includes('pg_advisory_lock')) releaseLock = await locks.acquire(String(params[0]) + String(params[1]));
        if (sql.includes('pg_advisory_unlock')) releaseLock?.();
        return {};
      },
      release() {}
    };
  };
  const upload = async () => {
    const req = { user: { companyId: 'company-a' }, plan: { id: 1, name: 'Starter', max_storage_bytes: 10 }, file: { size: 6 } };
    const res = response();
    await checkPlanLimit('storage', { getRequestedUsage: (request) => request.file.size })(req, res, () => {
      storedBytes += req.file.size;
      res.emit('finish');
    });
    return res.statusCode;
  };
  try {
    const statuses = await Promise.all([upload(), upload()]);
    assert.deepEqual(statuses.sort(), [200, 403]);
    assert.equal(storedBytes, 6);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});
