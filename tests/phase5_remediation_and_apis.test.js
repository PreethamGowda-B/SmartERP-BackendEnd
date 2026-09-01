/**
 * tests/phase5_remediation_and_apis.test.js
 *
 * Phase 5 Integration Test Suite:
 * 1. Deterministic policy decisions (Safe Auto Actions vs Sensitive Approval Gates)
 * 2. Idempotency & duplicate action prevention across retries
 * 3. Action execution and rollback/reversal handling
 * 4. Sensitive action Super Admin approval workflow
 * 5. Super Admin API authorization enforcement & non-SuperAdmin 403 denial
 */

require('dotenv').config();
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { redisClient } = require('../utils/redis');
const {
  SECURITY_ACTION_TYPES,
  evaluatePolicyForIncident,
  applyRemediationPolicy,
} = require('../utils/securityPolicyEngine');
const {
  executeSecurityAction,
  revertSecurityAction,
} = require('../utils/securityActionExecutor');
const { processSecurityIncident } = require('../jobs/securityWorker');
const { SECURITY_EVENT_TYPES } = require('../utils/securityEmitter');
const { authenticateSuperAdmin } = require('../middleware/adminMiddleware');

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-security-ai-verification';

function generateTestToken(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' });
}

async function runPhase5Tests() {
  console.log('🧪 Starting Phase 5 Remediation Policy & Super Admin Security Tests...\n');
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

  // ── Test 1: Policy Engine Decision Logic ────────────────────────────────────
  {
    const mockProbeIncident = {
      id: '00000000-0000-0000-0000-000000000001',
      threat_category: 'SUPERADMIN_PROBE',
      risk_score: 90,
      source_ip: '203.0.113.88',
      target_user_id: null,
      company_id: '1',
    };

    const decisions = evaluatePolicyForIncident(mockProbeIncident);
    const hasSafeThrottle = decisions.some((d) => d.actionType === SECURITY_ACTION_TYPES.IP_THROTTLE_TEMPORARY && d.isAutomated === true);
    const hasSensitiveBlock = decisions.some((d) => d.actionType === SECURITY_ACTION_TYPES.IP_BLOCK_PERMANENT && d.requiresApproval === true);

    assert(hasSafeThrottle, 'Policy engine proposes safe automated IP throttle for SuperAdmin probe');
    assert(hasSensitiveBlock, 'Policy engine gates permanent IP block behind mandatory Super Admin approval');
  }

  // ── Test 2: Idempotency & Duplicate Prevention on Repeated Ingest ───────────
  const testIp = `198.51.220.${Math.floor(Math.random() * 200) + 10}`;
  let testIncident = null;
  {
    for (let i = 1; i <= 5; i++) {
      await pool.query(
        `INSERT INTO security_events (company_id, user_id, event_type, severity, ip_address, endpoint, http_method, status_code, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        ['1', null, SECURITY_EVENT_TYPES.AUTH_FAILED, 'medium', testIp, '/api/auth/login', 'POST', 401, JSON.stringify({ reason: 'invalid_password' })]
      );
    }

    testIncident = await processSecurityIncident({ ipAddress: testIp, companyId: '1' });
    assert(testIncident !== null, 'Incident generated for policy test');

    // Run applyRemediationPolicy twice
    const actionsRun1 = await applyRemediationPolicy(testIncident);
    const actionsRun2 = await applyRemediationPolicy(testIncident);

    assert(actionsRun1.length > 0, 'Policy generated remediation actions for incident');
    assert(actionsRun1.length === actionsRun2.length, 'Idempotency verified: duplicate policy application returned existing records without re-inserting');

    const dbActions = await pool.query('SELECT COUNT(*) FROM security_actions WHERE incident_id = $1', [testIncident.id]);
    assert(parseInt(dbActions.rows[0].count, 10) === actionsRun1.length, 'Database contains exactly the expected count of unique action records');
  }

  // ── Test 3: Action Execution & Reversal/Rollback Handling ───────────────────
  {
    // Insert a safe reversible IP throttle action
    const insertActionRes = await pool.query(
      `INSERT INTO security_actions (incident_id, company_id, action_type, is_automated, approval_status, details, created_at)
       VALUES ($1, '1', $2, TRUE, 'pending', $3, NOW())
       RETURNING *`,
      [testIncident.id, SECURITY_ACTION_TYPES.IP_THROTTLE_TEMPORARY, JSON.stringify({ ipAddress: testIp, durationMinutes: 15 })]
    );
    const action = insertActionRes.rows[0];

    const execRes = await executeSecurityAction(action.id, 'test-runner');
    assert(execRes.success === true, 'Safe action executed successfully');
    assert(execRes.action.approval_status === 'executed', 'Action status updated to executed');

    // Rollback / Reversal
    const revertRes = await revertSecurityAction(action.id, 'super_admin_reviewer');
    assert(revertRes.success === true, 'Action successfully reverted/rolled back');
    assert(revertRes.action.approval_status === 'reverted', 'Action status updated to reverted');
  }

  // ── Test 4: Sensitive Action Approval Gate Enforcement ──────────────────────
  {
    const insertSensitiveRes = await pool.query(
      `INSERT INTO security_actions (incident_id, company_id, action_type, is_automated, approval_status, details, created_at)
       VALUES ($1, '1', $2, FALSE, 'pending', $3, NOW())
       RETURNING *`,
      [testIncident.id, SECURITY_ACTION_TYPES.USER_SUSPEND, JSON.stringify({ userId: '00000000-0000-0000-0000-000000000001' })]
    );
    const sensitiveAction = insertSensitiveRes.rows[0];

    // Automated engine attempt MUST be rejected
    const autoAttempt = await executeSecurityAction(sensitiveAction.id, 'security-policy-engine');
    assert(autoAttempt.success === false && autoAttempt.error === 'APPROVAL_REQUIRED', 'Automated engine rejected from executing sensitive user suspension');

    // Super Admin approval succeeds
    await pool.query(`UPDATE security_actions SET approval_status = 'approved' WHERE id = $1`, [sensitiveAction.id]);
    const approvedAttempt = await executeSecurityAction(sensitiveAction.id, 'super_admin@company.com');
    assert(approvedAttempt.success === true, 'Sensitive action executed successfully after Super Admin approval');
  }

  // ── Test 5: Super Admin Authorization Boundaries & Non-Admin Denial ─────────
  {
    const superAdminReq = {
      user: { role: 'super_admin', email: 'superadmin@smarterp.io', id: 'sa-1' },
      method: 'GET',
      path: '/api/v1/superadmin/security/dashboard',
    };
    let superAdminAllowed = false;
    authenticateSuperAdmin(superAdminReq, {}, () => {
      superAdminAllowed = true;
    });
    assert(superAdminAllowed, 'SuperAdmin role is granted access through authenticateSuperAdmin');

    const employeeReq = {
      user: { role: 'employee', email: 'technician@company.com', id: 'emp-1' },
      method: 'GET',
      path: '/api/v1/superadmin/security/dashboard',
    };
    let employeeStatus = null;
    const employeeRes = {
      status: (code) => {
        employeeStatus = code;
        return { json: () => {} };
      }
    };
    authenticateSuperAdmin(employeeReq, employeeRes, () => {});
    assert(employeeStatus === 403, 'Employee role receives 403 Forbidden on security endpoints');

    const ownerReq = {
      user: { role: 'owner', email: 'owner@company.com', id: 'own-1' },
      method: 'GET',
      path: '/api/v1/superadmin/security/dashboard',
    };
    let ownerStatus = null;
    const ownerRes = {
      status: (code) => {
        ownerStatus = code;
        return { json: () => {} };
      }
    };
    authenticateSuperAdmin(ownerReq, ownerRes, () => {});
    assert(ownerStatus === 403, 'Company Owner receives 403 Forbidden on security endpoints');
  }

  console.log(`\n📊 Phase 5 Test Summary: ${passed} Passed, ${failed} Failed\n`);

  pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

runPhase5Tests().catch((e) => {
  console.error('Fatal Phase 5 test runner error:', e);
  process.exit(1);
});
