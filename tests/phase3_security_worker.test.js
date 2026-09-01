/**
 * tests/phase3_security_worker.test.js
 *
 * Phase 3 Integration Test Suite:
 * 1. Deterministic risk calculation & severity calibration
 * 2. Sliding-window telemetry aggregation & incident creation
 * 3. Incident deduplication within 15-minute time window
 * 4. Multi-vector surge correlation
 * 5. Super Admin unauthorized access correlation
 */

require('dotenv').config();
const { pool } = require('../db');
const {
  processSecurityIncident,
  calculateDeterministicRisk,
  THREAT_CATEGORIES,
} = require('../jobs/securityWorker');
const { SECURITY_EVENT_TYPES } = require('../utils/securityEmitter');

async function runPhase3Tests() {
  console.log('🧪 Starting Phase 3 Security Worker & Aggregator Integration Tests...\n');
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

  // ── Test 1: Deterministic Risk Formula Calibration ─────────────────────────
  {
    const r1 = calculateDeterministicRisk(THREAT_CATEGORIES.SUPERADMIN_PROBE, { [SECURITY_EVENT_TYPES.ADMIN_UNAUTHORIZED]: 1 }, 1);
    assert(r1.riskScore >= 85 && r1.severity === 'critical', 'SuperAdmin probe receives critical base risk score >= 85');

    const r2 = calculateDeterministicRisk(THREAT_CATEGORIES.CROSS_TENANT_IDOR, { [SECURITY_EVENT_TYPES.TENANT_MISMATCH]: 2 }, 1);
    assert(r2.riskScore >= 70 && (r2.severity === 'high' || r2.severity === 'critical'), 'Cross-tenant IDOR receives high or critical risk score >= 70');

    const r3 = calculateDeterministicRisk(THREAT_CATEGORIES.CREDENTIAL_STUFFING, { [SECURITY_EVENT_TYPES.AUTH_FAILED]: 6 }, 1);
    assert(r3.riskScore >= 70, '6 failed logins scale risk score >= 70');

    const r4 = calculateDeterministicRisk(THREAT_CATEGORIES.MULTI_VECTOR_SURGE, { [SECURITY_EVENT_TYPES.AUTH_FAILED]: 5, [SECURITY_EVENT_TYPES.ROUTE_SCAN]: 10, [SECURITY_EVENT_TYPES.RBAC_DENIED]: 3 }, 3);
    assert(r4.riskScore >= 90 && r4.severity === 'critical', 'Multi-vector surge receives critical risk score >= 90');
  }

  // ── Test 2: Live Database Event Aggregation & Incident Creation ─────────────
  const testIp1 = `198.51.200.${Math.floor(Math.random() * 200) + 10}`;
  {
    // Insert 5 raw telemetry events for testIp1
    for (let i = 1; i <= 5; i++) {
      await pool.query(
        `INSERT INTO security_events (company_id, user_id, event_type, severity, ip_address, endpoint, http_method, status_code, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        ['1', '00000000-0000-0000-0000-000000000001', SECURITY_EVENT_TYPES.AUTH_FAILED, 'medium', testIp1, '/api/auth/login', 'POST', 401, JSON.stringify({ reason: 'invalid_password' })]
      );
    }

    const incident = await processSecurityIncident({ ipAddress: testIp1, companyId: '1' });
    assert(incident !== null, 'processSecurityIncident created an incident record');
    assert(incident?.threat_category === THREAT_CATEGORIES.CREDENTIAL_STUFFING, 'Threat category identified as CREDENTIAL_STUFFING');
    assert(incident?.risk_score >= 65, 'Calculated risk score is >= 65');
    assert(incident?.status === 'open', 'New incident created in open status');
    assert(incident?.ai_analysis?.totalEventsInWindow === 5, 'Evidence payload records 5 events in window');
    assert(Array.isArray(incident?.ai_analysis?.correlatedEventIds), 'Evidence payload includes correlated event IDs array');
  }

  // ── Test 3: Incident Deduplication & Correlation in Window ─────────────────
  {
    // Insert 2 more events from the same testIp1
    for (let i = 1; i <= 2; i++) {
      await pool.query(
        `INSERT INTO security_events (company_id, user_id, event_type, severity, ip_address, endpoint, http_method, status_code, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        ['1', '00000000-0000-0000-0000-000000000001', SECURITY_EVENT_TYPES.AUTH_FAILED, 'medium', testIp1, '/api/auth/login', 'POST', 401, JSON.stringify({ reason: 'invalid_password' })]
      );
    }

    const updatedIncident = await processSecurityIncident({ ipAddress: testIp1, companyId: '1' });
    assert(updatedIncident !== null, 'Incident updated on subsequent aggregation');
    assert(updatedIncident?.event_count === 7, 'Incident event_count updated to 7 (5 + 2)');

    // Verify in DB that only 1 incident row exists for this testIp1
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM security_incidents WHERE source_ip = $1 AND threat_category = $2`,
      [testIp1, THREAT_CATEGORIES.CREDENTIAL_STUFFING]
    );
    assert(parseInt(countRes.rows[0].count, 10) === 1, 'Deduplication verified: exactly 1 incident record exists for the IP window');
  }

  // ── Test 4: Super Admin Unauthorized Probing Incident ───────────────────────
  const testIp2 = `198.51.200.${Math.floor(Math.random() * 200) + 10}`;
  {
    await pool.query(
      `INSERT INTO security_events (company_id, user_id, event_type, severity, ip_address, endpoint, http_method, status_code, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      ['1', '00000000-0000-0000-0000-000000000002', SECURITY_EVENT_TYPES.ADMIN_UNAUTHORIZED, 'high', testIp2, '/api/v1/admin/companies', 'GET', 403, JSON.stringify({ userEmail: 'hacker@target.com' })]
    );

    const adminIncident = await processSecurityIncident({ ipAddress: testIp2, companyId: '1' });
    assert(adminIncident?.threat_category === THREAT_CATEGORIES.SUPERADMIN_PROBE, 'Identified SUPERADMIN_PROBE threat category');
    assert(adminIncident?.severity === 'critical', 'Super Admin probe classified as critical severity');
    assert(adminIncident?.risk_score >= 85, 'Super Admin probe risk score is >= 85');
  }

  // ── Test 5: Multi-Vector Anomaly Correlation ────────────────────────────────
  const testIp3 = `198.51.200.${Math.floor(Math.random() * 200) + 10}`;
  {
    // Insert 1 route scan + 1 failed auth
    await pool.query(
      `INSERT INTO security_events (company_id, user_id, event_type, severity, ip_address, endpoint, http_method, status_code, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      ['1', null, SECURITY_EVENT_TYPES.ROUTE_SCAN, 'medium', testIp3, '/.env', 'GET', 404, JSON.stringify({ pattern: 'probe' })]
    );
    await pool.query(
      `INSERT INTO security_events (company_id, user_id, event_type, severity, ip_address, endpoint, http_method, status_code, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      ['1', null, SECURITY_EVENT_TYPES.AUTH_FAILED, 'medium', testIp3, '/api/auth/login', 'POST', 401, JSON.stringify({ reason: 'user_not_found' })]
    );

    const multiIncident = await processSecurityIncident({ ipAddress: testIp3, companyId: '1' });
    assert(multiIncident?.threat_category === THREAT_CATEGORIES.MULTI_VECTOR_SURGE, 'Identified MULTI_VECTOR_SURGE threat category');
    assert(multiIncident?.risk_score >= 90, 'Multi-vector anomaly receives risk score >= 90');
  }

  console.log(`\n📊 Phase 3 Test Summary: ${passed} Passed, ${failed} Failed\n`);

  pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

runPhase3Tests().catch((e) => {
  console.error('Fatal Phase 3 test runner error:', e);
  process.exit(1);
});
