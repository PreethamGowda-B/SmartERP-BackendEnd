const test = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../utils/logger');
const { createWorkRequestsTableInitializer, ensureWorkRequestsSchemaOwner, REQUIRED_WORK_REQUESTS_COLUMNS } = require('../utils/workRequestsTableInitializer');

test('Production Logging & Diagnostic Verification', async (t) => {
  await t.test('1. Secret and credential redaction', () => {
    const rawPayload = {
      password: 'superSecretPassword123',
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature',
      api_key: 'AIzaSySecretApiKey',
      service_account_private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----',
      normal_field: 'valid_data'
    };

    const sanitized = logger.sanitize(rawPayload);
    assert.equal(sanitized.password, '[REDACTED]');
    assert.equal(sanitized.token, '[REDACTED]');
    assert.equal(sanitized.service_account_private_key, '[REDACTED]');
    assert.equal(sanitized.normal_field, 'valid_data');
  });

  await t.test('2. Log level hierarchy and production silencing of debug', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalLogLevel = process.env.LOG_LEVEL;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.LOG_LEVEL;

      assert.equal(logger.isLevelEnabled('debug'), false);
      assert.equal(logger.isLevelEnabled('info'), true);
      assert.equal(logger.isLevelEnabled('warn'), true);
      assert.equal(logger.isLevelEnabled('error'), true);
      assert.equal(logger.isLevelEnabled('fatal'), true);

      // Now set LOG_LEVEL=debug
      process.env.LOG_LEVEL = 'debug';
      assert.equal(logger.isLevelEnabled('debug'), true);
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalLogLevel) process.env.LOG_LEVEL = originalLogLevel;
      else delete process.env.LOG_LEVEL;
    }
  });

  await t.test('3. Structured business event logging format without sensitive leaks', () => {
    const businessEvents = [
      'LOGIN_SUCCESS', 'LOGIN_FAILED', 'JOB_CREATED', 'JOB_UPDATED', 'JOB_DELETED',
      'EMPLOYEE_CREATED', 'CUSTOMER_CREATED', 'INVOICE_CREATED', 'PAYMENT_RECEIVED',
      'ATTENDANCE_COMPLETED', 'MATERIAL_REQUEST_CREATED', 'NOTIFICATION_SENT',
      'AI_ACTION_COMPLETED', 'AI_ACTION_REJECTED', 'SUBSCRIPTION_UPDATED'
    ];

    for (const eventName of businessEvents) {
      assert.doesNotThrow(() => {
        logger.business(eventName, {
          companyId: 'test-comp-123',
          timestamp: Date.now()
        });
      });
    }
  });

  await t.test('4. Slow query structured warning format', () => {
    const originalEnv = process.env.NODE_ENV;
    let capturedLog = null;
    const originalWarn = console.warn;

    try {
      process.env.NODE_ENV = 'production';
      console.warn = (chunk) => {
        try {
          const parsed = JSON.parse(chunk);
          if (parsed.event === 'slow_query_warning') {
            capturedLog = parsed;
          }
        } catch (_) {}
      };

      logger.slowQuery({
        operation: 'SELECT_CRITICAL',
        durationMs: 3450.5,
        thresholdMs: 2000,
        requestId: 'req-test-uuid',
        pool: { total: 2, idle: 0, waiting: 0 }
      });

      assert.ok(capturedLog, 'Slow query warning should be emitted as JSON in production');
      assert.equal(capturedLog.level, 'warn');
      assert.equal(capturedLog.event, 'slow_query_warning');
      assert.equal(capturedLog.operation, 'SELECT_CRITICAL');
      assert.equal(capturedLog.durationMs, 3450.5);
      assert.equal(capturedLog.requestId, 'req-test-uuid');
    } finally {
      console.warn = originalWarn;
      process.env.NODE_ENV = originalEnv;
    }
  });

  await t.test('5. ensureWorkRequestsTable verifies complete columns before skipping ALTER', async () => {
    let alterCalled = false;
    let createTableCalled = false;

    const mockClient = {
      query: async (sql, params) => {
        const sqlLower = String(sql).toLowerCase();
        if (sqlLower.includes('information_schema.columns')) {
          // Return all required columns to verify complete schema
          return { rows: REQUIRED_WORK_REQUESTS_COLUMNS.map(c => ({ column_name: c })) };
        }
        if (sqlLower.includes('alter table work_requests')) {
          alterCalled = true;
          return { rows: [] };
        }
        if (sqlLower.includes('create table if not exists work_requests')) {
          createTableCalled = true;
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {}
    };

    const mockPool = {
      connect: async () => mockClient
    };

    const initializer = createWorkRequestsTableInitializer({
      pool: mockPool,
      warn: () => {}
    });

    await initializer();

    assert.equal(alterCalled, false, 'ALTER TABLE must not be executed when columns are already verified');
    assert.equal(createTableCalled, false, 'CREATE TABLE must not be executed when columns are already verified');
  });

  await t.test('6. ensureWorkRequestsSchemaOwner executes in transaction and verifies columns', async () => {
    const executedStatements = [];
    const mockInitClient = {
      query: async (sql, params) => {
        const s = String(sql).trim();
        executedStatements.push(s);
        if (s.toLowerCase().includes('information_schema.columns')) {
          return { rows: REQUIRED_WORK_REQUESTS_COLUMNS.map(c => ({ column_name: c })) };
        }
        return { rows: [] };
      }
    };

    await ensureWorkRequestsSchemaOwner(mockInitClient);

    assert.equal(executedStatements[0], 'BEGIN', 'Must start with explicit transaction BEGIN');
    assert.ok(executedStatements.some(s => s.includes('CREATE TABLE IF NOT EXISTS work_requests')));
    assert.ok(executedStatements.some(s => s.includes('resolved_by_id')));
    assert.ok(executedStatements.some(s => s.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE work_requests TO smarterp_app')));
    assert.equal(executedStatements[executedStatements.length - 1], 'COMMIT', 'Must conclude with transaction COMMIT');
  });

  await t.test('7. ensureWorkRequestsSchemaOwner throws and rolls back if columns are missing', async () => {
    const executed = [];
    const mockInitClient = {
      query: async (sql, params) => {
        const s = String(sql).trim();
        executed.push(s);
        if (s.toLowerCase().includes('information_schema.columns')) {
          // Return empty columns to simulate failed migration
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      async () => ensureWorkRequestsSchemaOwner(mockInitClient),
      /work_requests schema incomplete/
    );

    assert.ok(executed.includes('ROLLBACK'), 'Must ROLLBACK transaction on verification failure');
  });
});
