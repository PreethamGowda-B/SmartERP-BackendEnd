'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkRequestsTableInitializer } = require('../utils/workRequestsTableInitializer');

test('work request schema initialization is single-flight and stops after owner denial', async () => {
  let connectCount = 0;
  let queryCount = 0;
  let releaseCount = 0;
  const warnings = [];
  const db = {
    async connect() {
      connectCount += 1;
      return {
        async query(sql) {
          queryCount += 1;
          if (sql.includes('ALTER TABLE work_requests')) {
            const error = new Error('must be owner of table work_requests');
            error.code = '42501';
            throw error;
          }
          return { rows: [] };
        },
        release() {
          releaseCount += 1;
        },
      };
    },
  };
  const ensureSchema = createWorkRequestsTableInitializer({
    db,
    warn: (...args) => warnings.push(args),
  });

  await Promise.all(Array.from({ length: 20 }, () => ensureSchema()));
  await ensureSchema();

  assert.equal(connectCount, 1, 'concurrent requests share one initialization');
  assert.equal(queryCount, 2, 'owner denial stops further DDL attempts');
  assert.equal(releaseCount, 1, 'the initialization client is always released');
  assert.equal(warnings.length, 1, 'owner denial is logged once per process');
  assert.match(warnings[0][0], /apply required schema changes with the table owner/);
});
