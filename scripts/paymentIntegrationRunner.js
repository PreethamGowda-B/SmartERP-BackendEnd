'use strict';

/**
 * SmartERP Phase 8 — Payment Idempotency Live Integration Runner
 *
 * SAFETY RESTRICTIONS:
 * 1. Strictly requires runPreflight() from paymentTestDatabasePreflight.js to PASS.
 * 2. Refuses to connect if preflight fails or if environment is not isolated_test.
 * 3. Never uses postgres superuser or BYPASSRLS roles (strictly uses smarterp_test_runner).
 * 4. Never touches production data.
 * 5. Uses disposable fixture companies and cleans up ONLY records created during the run.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const {
  loadTestEnvironment,
  runPreflight,
  assertDedicatedTestDatabaseName,
} = require('./paymentTestDatabasePreflight');
const {
  FORWARD_MIGRATIONS,
  INVOICE_PAYMENT_IDEMPOTENCY,
  applyForwardMigration,
  migrationChecksum,
  assertInvoicePaymentIdempotencySchema,
} = require('../migrations/forwardMigrationRunner');

// Enforce isolated test configuration in process.env BEFORE loading application domain services
const env = loadTestEnvironment();
process.env.SMARTERP_ENVIRONMENT = 'isolated_test';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = env.TEST_DATABASE_URL;

const { pool: appDbPool } = require('../db');
const invoiceService = require('../services/invoiceService');

async function runIntegrationSuite({
  env: activeEnv = env,
  controlledMigration = false,
} = {}) {
  console.log('--- Step 1: Running Database Safety Preflight ---');
  const preflightReport = await runPreflight({ env: activeEnv });
  console.log(`Preflight status: ${preflightReport.status}`);
  console.log(`Verified test project: ${preflightReport.projectRef}`);
  console.log(`Verified test role: ${preflightReport.role}`);
  assertDedicatedTestDatabaseName(preflightReport.database);

  const pool = new Pool({
    connectionString: activeEnv.TEST_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 20000,
    max: 5,
  });

  const results = {
    preflight: preflightReport,
    schemaChanges: [],
    tests: [],
  };

  try {
    console.log('--- Step 2: Read-Only Schema Inspection ---');
    const tableRes = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('invoices', 'invoice_payments', 'companies', 'ar_collection_schedules');"
    );
    const existingTables = tableRes.rows.map((r) => r.table_name);
    console.log('Existing tables in public schema:', existingTables);

    const requiredTables = ['invoices', 'invoice_payments', 'companies', 'ar_collection_schedules'];
    const missingTables = requiredTables.filter((table) => !existingTables.includes(table));
    if (missingTables.length) {
      throw new Error(`Test database lacks required pre-provisioned tables: ${missingTables.join(', ')}. This runner will not create a financial schema.`);
    }

    const migration = FORWARD_MIGRATIONS.find((item) => item.id === INVOICE_PAYMENT_IDEMPOTENCY.id);
    if (!migration) throw new Error('Migration 039 is not registered in the reviewed forward-migration allow-list.');
    const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', migration.file), 'utf8');
    if (controlledMigration) {
      console.log('--- Step 3: Applying or verifying controlled Migration 039 ---');
      const client = await pool.connect();
      try {
        const migrationResult = await applyForwardMigration(client, { migrationId: migration.id, sql: migrationSql });
        results.schemaChanges.push(`Migration 039 ${migrationResult.status}`);
      } finally {
        client.release();
      }
    } else {
      const history = await pool.query(
        'SELECT checksum_sha256 FROM app_migration_history WHERE migration_id = $1',
        [migration.id]
      );
      if (String(history.rows[0]?.checksum_sha256 || '').trim() !== migrationChecksum(migrationSql)) {
        throw new Error('Migration 039 has no matching checksum history record. Reconcile its schema through the controlled migration runner before testing.');
      }
      await assertInvoicePaymentIdempotencySchema(pool);
    }
    await assertInvoicePaymentIdempotencySchema(pool);
    results.verifiedSchema = { columnsPresent: true, hasPartialIndex: true, hasCheckConstraint: true };

    console.log('--- Step 4: Executing Live Integration Scenarios ---');
    const testCompanyIds = [];
    const testInvoiceIds = [];
    const fixtureRunId = crypto.randomUUID();
    const key1 = `test:${crypto.randomUUID()}`;
    let fixturesCommitted = false;

    try {
      const fixtureClient = await pool.connect();
      try {
        await fixtureClient.query('BEGIN');
        for (const tenantNumber of [1, 2]) {
          const company = await fixtureClient.query(
            'INSERT INTO companies (name, created_at) VALUES ($1, NOW()) RETURNING id',
            [`SmartERP isolated payment test ${fixtureRunId} tenant ${tenantNumber}`]
          );
          testCompanyIds.push(company.rows[0].id);
        }
        const firstInvoiceId = crypto.randomUUID();
        const secondInvoiceId = crypto.randomUUID();
        testInvoiceIds.push(firstInvoiceId, secondInvoiceId);
        await fixtureClient.query(
          `INSERT INTO invoices (id, company_id, invoice_number, total_amount, amount_paid, amount_due, status, created_at, updated_at)
           VALUES ($1, $2, $3, 100.00, 0.00, 100.00, 'unpaid', NOW(), NOW()),
                  ($4, $5, $6, 100.00, 0.00, 100.00, 'unpaid', NOW(), NOW())`,
          [firstInvoiceId, testCompanyIds[0], `IT-${fixtureRunId}-1`, secondInvoiceId, testCompanyIds[1], `IT-${fixtureRunId}-2`]
        );
        fixturesCommitted = true;
        await fixtureClient.query('COMMIT');
      } catch (error) {
        await fixtureClient.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        fixtureClient.release();
      }
      const [testInvoiceId, testInvoiceId2] = testInvoiceIds;
      const [testCompanyId, testCompanyId2] = testCompanyIds;

      // Scenario 1: Same key and same request returns original committed result under concurrency
      console.log('Scenario 1: Concurrency Race with identical idempotency key...');
      const [res1, res2] = await Promise.all([
        invoiceService.recordPayment({
          invoiceId: testInvoiceId,
          companyId: testCompanyId,
          paymentMethod: 'cash',
          amount: 40.0,
          transactionReference: 'REF-CONC-1',
          notes: 'Concurrent test 1',
          idempotencyKey: key1,
        }),
        invoiceService.recordPayment({
          invoiceId: testInvoiceId,
          companyId: testCompanyId,
          paymentMethod: 'cash',
          amount: 40.0,
          transactionReference: 'REF-CONC-1',
          notes: 'Concurrent test 1',
          idempotencyKey: key1,
        }),
      ]);

      const paymentRows = await pool.query(
        'SELECT id, amount, result_status, result_amount_paid, result_amount_due FROM invoice_payments WHERE company_id = $1 AND idempotency_key = $2;',
        [testCompanyId, key1]
      );

      const concurrentPass =
        paymentRows.rows.length === 1 &&
        res1.success === true &&
        res2.success === true &&
        res1.amountPaid === 40.0 &&
        res2.amountPaid === 40.0 &&
        res1.amountDue === 60.0 &&
        res2.amountDue === 60.0;

      results.tests.push({
        scenario: 'Scenario 1: Concurrent identical idempotency key requests',
        description: 'Parallel execution produces exactly one persisted payment and identical replayed result',
        passed: concurrentPass,
        details: {
          rowsCreated: paymentRows.rows.length,
          res1AmountPaid: res1.amountPaid,
          res2AmountPaid: res2.amountPaid,
        },
      });
      console.log(`Scenario 1: ${concurrentPass ? 'PASSED' : 'FAILED'}`);

      // Scenario 2: Same key with changed details is rejected with 409
      console.log('Scenario 2: Key reuse with modified payment details...');
      let mismatchRejected = false;
      let mismatchStatusCode = null;
      try {
        await invoiceService.recordPayment({
          invoiceId: testInvoiceId,
          companyId: testCompanyId,
          paymentMethod: 'cash',
          amount: 50.0, // Changed from 40.0
          transactionReference: 'REF-CONC-1',
          notes: 'Concurrent test 1',
          idempotencyKey: key1,
        });
      } catch (mismatchErr) {
        mismatchStatusCode = mismatchErr.statusCode;
        mismatchRejected = mismatchErr.statusCode === 409;
      }

      results.tests.push({
        scenario: 'Scenario 2: Reusing key with changed payment details',
        description: 'Rejected with HTTP 409 Conflict',
        passed: mismatchRejected,
        details: { statusCode: mismatchStatusCode },
      });
      console.log(`Scenario 2: ${mismatchRejected ? 'PASSED' : 'FAILED'}`);

      // Scenario 3: Distinct keys allow legitimate installments
      console.log('Scenario 3: Distinct idempotency keys for sequential installments...');
      const key2 = `test:${crypto.randomUUID()}`;
      const installmentRes = await invoiceService.recordPayment({
        invoiceId: testInvoiceId,
        companyId: testCompanyId,
        paymentMethod: 'upi',
        amount: 30.0,
        transactionReference: 'REF-INST-2',
        notes: 'Installment 2',
        idempotencyKey: key2,
      });

      const installmentPass =
        installmentRes.success === true &&
        installmentRes.amountPaid === 70.0 &&
        installmentRes.amountDue === 30.0;

      results.tests.push({
        scenario: 'Scenario 3: Legitimate sequential installments with distinct keys',
        description: 'Second payment succeeds and accumulates totals correctly',
        passed: installmentPass,
        details: { amountPaid: installmentRes.amountPaid, amountDue: installmentRes.amountDue },
      });
      console.log(`Scenario 3: ${installmentPass ? 'PASSED' : 'FAILED'}`);

      // Scenario 4: Cross-company isolation with same key
      console.log('Scenario 4: Cross-company tenant isolation with identical key...');
      const crossTenantRes = await invoiceService.recordPayment({
        invoiceId: testInvoiceId2,
        companyId: testCompanyId2,
        paymentMethod: 'cash',
        amount: 50.0,
        transactionReference: 'REF-TENANT-2',
        notes: 'Company 2 payment',
        idempotencyKey: key1, // Same key as Company 1, but in Company 2 context
      });

      const crossTenantPass =
        crossTenantRes.success === true &&
        crossTenantRes.amountPaid === 50.0 &&
        crossTenantRes.amountDue === 50.0;

      results.tests.push({
        scenario: 'Scenario 4: Cross-company tenant isolation with same key',
        description: 'Different company executes independently without collision or leaking results',
        passed: crossTenantPass,
        details: { amountPaid: crossTenantRes.amountPaid, amountDue: crossTenantRes.amountDue },
      });
      console.log(`Scenario 4: ${crossTenantPass ? 'PASSED' : 'FAILED'}`);

      // Scenario 5: Legacy keyless payment compatibility
      console.log('Scenario 5: Legacy keyless payment compatibility...');
      const keylessRes = await invoiceService.recordPayment({
        invoiceId: testInvoiceId,
        companyId: testCompanyId,
        paymentMethod: 'cash',
        amount: 10.0,
        transactionReference: 'REF-LEGACY-1',
        notes: 'Legacy keyless payment',
      });

      const keylessPass =
        keylessRes.success === true &&
        keylessRes.amountPaid === 80.0 &&
        keylessRes.amountDue === 20.0;

      results.tests.push({
        scenario: 'Scenario 5: Legacy keyless payment',
        description: 'Keyless payment succeeds and accumulates totals without requiring idempotency key',
        passed: keylessPass,
        details: { amountPaid: keylessRes.amountPaid, amountDue: keylessRes.amountDue },
      });
      console.log(`Scenario 5: ${keylessPass ? 'PASSED' : 'FAILED'}`);

    } finally {
      if (fixturesCommitted) {
        // Cleanup is scoped to exact IDs created by this invocation.
        console.log('--- Step 5: Cleaning up this run’s disposable fixtures ---');
        const cleanup = await pool.connect();
        try {
          await cleanup.query('BEGIN');
          await cleanup.query('DELETE FROM invoice_payments WHERE invoice_id = ANY($1::uuid[]) AND company_id = ANY($2::int[])', [testInvoiceIds, testCompanyIds]);
          await cleanup.query('DELETE FROM ar_collection_schedules WHERE invoice_id = ANY($1::uuid[]) AND company_id = ANY($2::int[])', [testInvoiceIds, testCompanyIds]);
          await cleanup.query('DELETE FROM invoices WHERE id = ANY($1::uuid[]) AND company_id = ANY($2::int[])', [testInvoiceIds, testCompanyIds]);
          await cleanup.query('DELETE FROM companies WHERE id = ANY($1::int[])', [testCompanyIds]);
          await cleanup.query('COMMIT');
          console.log('Test fixtures cleaned up.');
        } catch (cleanupError) {
          await cleanup.query('ROLLBACK').catch(() => {});
          throw cleanupError;
        } finally {
          cleanup.release();
        }
      }
    }

    return results;
  } finally {
    await pool.end().catch(() => {});
    await appDbPool.end().catch(() => {});
  }
}

if (require.main === module) {
  const controlledMigration = process.argv.includes('--apply-migration') || process.argv.includes('--migrate');
  runIntegrationSuite({ controlledMigration })
    .then((res) => {
      console.log('\n=== LIVE INTEGRATION SUITE REPORT ===');
      console.log(JSON.stringify(res, null, 2));
      const allPassed = res.tests.every((t) => t.passed);
      process.exit(allPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error('\n❌ LIVE INTEGRATION SUITE FAILED:');
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = {
  runIntegrationSuite,
};
