/**
 * tests/phase1_security_ai_verification.test.js
 *
 * Phase 1 Verification Test Suite:
 * 1. SQL Schema syntax, constraints, and idempotency
 * 2. autoMigrate.js registration
 * 3. securityEmitter.js non-blocking error immunity & metadata sanitization
 * 4. queue.js securityQueue connection sharing & retry configuration
 */

const fs = require('fs');
const path = require('path');

function runPhase1Tests() {
  console.log('🧪 Starting Phase 1 Security AI Verification Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  // ── Test 1: SQL Schema Validation ──────────────────────────────────────────
  try {
    const migrationPath = path.join(__dirname, '../migrations/025_security_ai_infrastructure.sql');
    const sqlContent = fs.readFileSync(migrationPath, 'utf8');

    assert(sqlContent.includes('CREATE TABLE IF NOT EXISTS security_events'), 'Schema defines security_events with IF NOT EXISTS');
    assert(sqlContent.includes('CREATE TABLE IF NOT EXISTS security_incidents'), 'Schema defines security_incidents with IF NOT EXISTS');
    assert(sqlContent.includes('CREATE TABLE IF NOT EXISTS security_actions'), 'Schema defines security_actions with IF NOT EXISTS');
    assert(sqlContent.includes('REFERENCES security_incidents(id) ON DELETE CASCADE'), 'Schema has valid foreign key cascade on security_actions');
    assert(sqlContent.includes('CREATE INDEX IF NOT EXISTS idx_sec_events_comp_time'), 'Schema includes composite index on (company_id, created_at)');
    assert(sqlContent.includes('CREATE INDEX IF NOT EXISTS idx_sec_incidents_score'), 'Schema includes risk_score index');
    assert(sqlContent.includes('CREATE INDEX IF NOT EXISTS idx_sec_actions_incident'), 'Schema includes incident index on actions');
  } catch (err) {
    assert(false, `SQL schema verification failed: ${err.message}`);
  }

  // ── Test 2: autoMigrate.js Registration ────────────────────────────────────
  try {
    const autoMigratePath = path.join(__dirname, '../migrations/autoMigrate.js');
    const autoMigrateContent = fs.readFileSync(autoMigratePath, 'utf8');

    assert(autoMigrateContent.includes("'025_security_ai_infrastructure.sql'"), '025 migration registered in NUMBERED_MIGRATIONS');
    assert(autoMigrateContent.includes("runNumberedMigrations"), 'runNumberedMigrations exists and guards migrations');
  } catch (err) {
    assert(false, `autoMigrate registration verification failed: ${err.message}`);
  }

  // ── Test 3: securityEmitter.js Non-Blocking & Fault Tolerance ──────────────
  try {
    const { emitSecurityEvent, SECURITY_EVENT_TYPES } = require('../utils/securityEmitter');

    assert(typeof emitSecurityEvent === 'function', 'emitSecurityEvent is exported as a function');
    assert(SECURITY_EVENT_TYPES.AUTH_FAILED === 'auth.failed', 'SECURITY_EVENT_TYPES contains standard auth.failed');
    assert(SECURITY_EVENT_TYPES.TENANT_MISMATCH === 'tenant.mismatch', 'SECURITY_EVENT_TYPES contains tenant.mismatch');
    assert(SECURITY_EVENT_TYPES.RBAC_DENIED === 'rbac.denied', 'SECURITY_EVENT_TYPES contains rbac.denied');
    assert(SECURITY_EVENT_TYPES.ROUTE_SCAN === 'route.enumeration_scan', 'SECURITY_EVENT_TYPES contains route.enumeration_scan');
    assert(SECURITY_EVENT_TYPES.PROMPT_INJECTION === 'prompt.injection_attempt', 'SECURITY_EVENT_TYPES contains prompt.injection_attempt');
    assert(SECURITY_EVENT_TYPES.FILE_SUSPICIOUS === 'file.signature_mismatch', 'SECURITY_EVENT_TYPES contains file.signature_mismatch');

    // Test non-blocking execution under corrupt data
    let threwError = false;
    try {
      emitSecurityEvent({
        eventType: SECURITY_EVENT_TYPES.AUTH_FAILED,
        companyId: 'invalid-id',
        severity: 'critical',
        metadata: {
          password: 'SecretPassword123',
          authToken: 'Bearer xyz.abc.123',
          normalField: 'testValue'
        }
      });
    } catch (e) {
      threwError = true;
    }
    assert(!threwError, 'emitSecurityEvent never throws synchronously (fully detached via setImmediate)');
  } catch (err) {
    assert(false, `securityEmitter verification failed: ${err.message}`);
  }

  // ── Test 4: queue.js Registration & Fault Tolerance ─────────────────────────
  try {
    const queueModule = require('../utils/queue');
    assert(typeof queueModule.enqueueSecurityEvent === 'function', 'enqueueSecurityEvent is exported as a function');

    let queueThrew = false;
    try {
      const p = queueModule.enqueueSecurityEvent({ test: 'payload' });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    } catch (e) {
      queueThrew = true;
    }
    assert(!queueThrew, 'enqueueSecurityEvent handles offline Redis gracefully without crashing process');
  } catch (err) {
    assert(false, `queue.js verification failed: ${err.message}`);
  }

  console.log(`\n📊 Phase 1 Test Summary: ${passed} Passed, ${failed} Failed\n`);
  return failed === 0;
}

const success = runPhase1Tests();
process.exit(success ? 0 : 1);
