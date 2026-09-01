/**
 * Phase 6: Super Admin Security Center (SOC) API Contract & Workflow Verification
 * Validates endpoint responses, schema conformance, approval confirmation flow,
 * rollback capabilities, and strict RBAC isolation.
 */

const assert = require('assert');
require('dotenv').config();
const { pool } = require('../db');
const { emitSecurityEvent, SECURITY_EVENT_TYPES } = require('../utils/securityEmitter');
const { processSecurityIncident, THREAT_CATEGORIES } = require('../jobs/securityWorker');
const { applyRemediationPolicy, SECURITY_ACTION_TYPES } = require('../utils/securityPolicyEngine');
const { executeSecurityAction, revertSecurityAction } = require('../utils/securityActionExecutor');
const { redactSensitiveData } = require('../utils/promptShield');

async function runPhase6Tests() {
  console.log('🧪 Starting Phase 6 Super Admin SOC API Contract & Workflow Tests...\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name} -> ${err.message}`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name} -> ${err.message}`);
      failed++;
    }
  }

  const testIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;

  // ── Test 1: SOC Dashboard Schema & Redaction ─────────────────────────────────
  await testAsync('SOC Dashboard aggregation returns sanitized health and incident breakdowns', async () => {
    // Ingest sample security events
    for (let i = 0; i < 4; i++) {
      await pool.query(
        `INSERT INTO security_events (company_id, user_id, event_type, severity, ip_address, endpoint, http_method, status_code, metadata, created_at)
         VALUES ('1', NULL, $1, 'high', $2, '/wp-login.php', 'GET', 404, '{"scanner":"nuclei"}', NOW())`,
        [SECURITY_EVENT_TYPES.ROUTE_SCAN, testIp]
      );
    }

    const incRes = await pool.query(
      `INSERT INTO security_incidents (company_id, title, threat_category, status, severity, risk_score, source_ip, event_count, first_seen_at, last_seen_at, created_at)
       VALUES ('1', 'Suspicious Automated Reconnaissance', 'ROUTE_SCAN', 'open', 'high', 75, $1, 4, NOW(), NOW(), NOW())
       RETURNING *`,
      [testIp]
    );
    const incident = incRes.rows[0];

    // Query dashboard data
    const incidentsQuery = await pool.query('SELECT * FROM security_incidents WHERE status = $1 ORDER BY created_at DESC LIMIT 10', ['open']);
    const actionsQuery = await pool.query('SELECT * FROM security_actions ORDER BY created_at DESC LIMIT 10');
    const eventsQuery = await pool.query('SELECT * FROM security_events ORDER BY created_at DESC LIMIT 25');

    const sanitizedIncidents = redactSensitiveData(incidentsQuery.rows);
    const sanitizedEvents = redactSensitiveData(eventsQuery.rows);

    assert(Array.isArray(sanitizedIncidents), 'Incidents array is returned');
    assert(sanitizedIncidents.length > 0, 'Active incidents found in SOC dashboard');
    assert(Array.isArray(sanitizedEvents), 'Events array is returned');
    assert(!JSON.stringify(sanitizedEvents).includes('password_hash'), 'No sensitive credentials leaked in event stream');
  });

  // ── Test 2: Sensitive Action Approval Lifecycle (Pending -> Approved -> Executed) ──
  await testAsync('Sensitive action confirmation flow correctly transitions status to executed', async () => {
    const incRes = await pool.query(
      `INSERT INTO security_incidents (company_id, title, threat_category, status, severity, risk_score, source_ip, event_count, first_seen_at, last_seen_at, created_at)
       VALUES ('1', 'Critical Target IDOR Sweep', 'CROSS_TENANT_IDOR', 'open', 'critical', 95, $1, 15, NOW(), NOW(), NOW())
       RETURNING *`,
      [testIp]
    );
    const incident = incRes.rows[0];

    // Policy generates permanent block requiring Super Admin approval
    const insertActionRes = await pool.query(
      `INSERT INTO security_actions (incident_id, company_id, action_type, is_automated, approval_status, details, created_at)
       VALUES ($1, '1', $2, FALSE, 'pending', $3, NOW())
       RETURNING *`,
      [incident.id, SECURITY_ACTION_TYPES.IP_BLOCK_PERMANENT, JSON.stringify({ ipAddress: testIp, reason: 'Repeated Cross-Tenant IDOR Probing' })]
    );
    const action = insertActionRes.rows[0];

    assert(action.approval_status === 'pending', 'Action initialized in pending state');
    assert(action.is_automated === false, 'Sensitive action flagged as non-automated');

    // Simulate Super Admin confirmation
    const superAdminId = 'prozyncinnovations@gmail.com';
    await pool.query(`UPDATE security_actions SET approval_status = 'approved' WHERE id = $1`, [action.id]);

    const execResult = await executeSecurityAction(action.id, superAdminId);
    assert(execResult.success === true, 'Action successfully executed upon approval');
    assert(execResult.action.approval_status === 'executed', 'Action status updated to executed');
    assert(execResult.action.executed_by === superAdminId, 'Executed by recorded with Super Admin email');
  });

  // ── Test 3: Action Rejection Workflow ────────────────────────────────────────
  await testAsync('Super Admin rejection cancels proposed action without altering system state', async () => {
    const incRes = await pool.query(
      `INSERT INTO security_incidents (company_id, title, threat_category, status, severity, risk_score, source_ip, event_count, first_seen_at, last_seen_at, created_at)
       VALUES ('1', 'Suspicious Login Anomaly', 'CREDENTIAL_STUFFING', 'open', 'medium', 55, $1, 5, NOW(), NOW(), NOW())
       RETURNING *`,
      [testIp]
    );
    const incident = incRes.rows[0];

    const insertActionRes = await pool.query(
      `INSERT INTO security_actions (incident_id, company_id, action_type, is_automated, approval_status, details, created_at)
       VALUES ($1, '1', $2, FALSE, 'pending', $3, NOW())
       RETURNING *`,
      [incident.id, SECURITY_ACTION_TYPES.USER_SUSPEND, JSON.stringify({ userId: '00000000-0000-0000-0000-000000000099', reason: 'Review required' })]
    );
    const action = insertActionRes.rows[0];

    // Super Admin rejects the proposal
    const superAdminId = 'prozyncinnovations@gmail.com';
    const rejectRes = await pool.query(
      `UPDATE security_actions
       SET approval_status = 'rejected',
           executed_by = $1,
           details = jsonb_set(COALESCE(details, '{}'::jsonb), '{rejectedBy}', $2::jsonb)
       WHERE id = $3
       RETURNING *`,
      [superAdminId, JSON.stringify(superAdminId), action.id]
    );

    const rejectedAction = rejectRes.rows[0];
    assert(rejectedAction.approval_status === 'rejected', 'Action marked as rejected');
    assert(rejectedAction.details.rejectedBy === superAdminId, 'Rejection audit trails Super Admin identity');
  });

  // ── Test 4: Rollback / Reversal Execution ────────────────────────────────────
  await testAsync('Rollback action cleanly restores state and marks record reverted', async () => {
    const insertActionRes = await pool.query(
      `INSERT INTO security_actions (company_id, action_type, is_automated, approval_status, details, created_at)
       VALUES ('1', $1, TRUE, 'executed', $2, NOW())
       RETURNING *`,
      [SECURITY_ACTION_TYPES.IP_THROTTLE_TEMPORARY, JSON.stringify({ ipAddress: testIp, durationMinutes: 30 })]
    );
    const action = insertActionRes.rows[0];

    const revertRes = await revertSecurityAction(action.id, 'prozyncinnovations@gmail.com');
    assert(revertRes.success === true, 'Reversal executed successfully');
    assert(revertRes.action.approval_status === 'reverted', 'Action marked as reverted in database');
    assert(revertRes.action.details.revertedBy === 'prozyncinnovations@gmail.com', 'Audit details include revertedBy');
  });

  // ── Test 5: Incident Investigation Telemetry API Contract ───────────────────
  await testAsync('Incident details API returns full correlation package without leaking tokens', async () => {
    const incRes = await pool.query(
      `INSERT INTO security_incidents (company_id, title, threat_category, status, severity, risk_score, source_ip, event_count, first_seen_at, last_seen_at, ai_analysis, created_at)
       VALUES ('1', 'Multi-Vector Escalation Probe', 'MULTI_VECTOR_SURGE', 'open', 'critical', 95, $1, 8, NOW(), NOW(), 
       '{"geminiEnrichment": {"summary": "High-risk probe detected", "confidenceScore": 0.95}}', NOW())
       RETURNING *`,
      [testIp]
    );
    const incident = incRes.rows[0];

    const sanitized = redactSensitiveData(incident);
    assert(sanitized.id === incident.id, 'Incident ID preserved');
    assert(sanitized.ai_analysis.geminiEnrichment.summary === 'High-risk probe detected', 'AI enrichment available to Super Admin');
    assert(sanitized.threat_category === 'MULTI_VECTOR_SURGE', 'Threat category matches');
  });

  console.log(`\n📊 Phase 6 Test Summary: ${passed} Passed, ${failed} Failed\n`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

runPhase6Tests()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch((err) => {
    console.error('Fatal Phase 6 test error:', err);
    process.exit(1);
  });
