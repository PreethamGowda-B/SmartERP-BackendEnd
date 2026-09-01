/**
 * jobs/securityWorker.js
 *
 * BullMQ Security Worker & Deterministic Sliding-Window Aggregator.
 * Aggregates raw security telemetry events, identifies attack patterns across
 * sliding time windows, calculates calibrated risk scores, and correlates
 * events into deduplicated security incidents.
 */

const { Worker } = require('bullmq');
const { pool } = require('../db');
const { redisConnection } = require('../utils/queue');
const logger = require('../utils/logger');
const { SECURITY_EVENT_TYPES } = require('../utils/securityEmitter');

/**
 * Deterministic Threat Category Identifiers
 */
const THREAT_CATEGORIES = {
  CREDENTIAL_STUFFING: 'CREDENTIAL_STUFFING',
  SUPERADMIN_PROBE: 'SUPERADMIN_PROBE',
  CROSS_TENANT_IDOR: 'CROSS_TENANT_IDOR',
  PRIVILEGE_ESCALATION: 'PRIVILEGE_ESCALATION',
  ROUTE_SCAN: 'ROUTE_SCAN',
  MULTI_VECTOR_SURGE: 'MULTI_VECTOR_SURGE',
  COMPANY_SUSPENSION_BREACH: 'COMPANY_SUSPENSION_BREACH',
};

/**
 * Calculates a deterministic risk score (0 - 100) and severity.
 *
 * @param {string} category - Threat category
 * @param {Object} counts - Event counts by type in sliding window
 * @param {number} totalDistinctTypes - Number of distinct event types
 * @returns {{ riskScore: number, severity: string }}
 */
function calculateDeterministicRisk(category, counts, totalDistinctTypes) {
  let score = 30;

  switch (category) {
    case THREAT_CATEGORIES.SUPERADMIN_PROBE:
      // High baseline: probing Super Admin endpoints without permission
      score = 85 + Math.min(10, (counts[SECURITY_EVENT_TYPES.ADMIN_UNAUTHORIZED] || 1) * 3);
      break;

    case THREAT_CATEGORIES.CROSS_TENANT_IDOR:
      // High baseline: attempting cross-tenant parameter access
      score = 70 + Math.min(25, (counts[SECURITY_EVENT_TYPES.TENANT_MISMATCH] || 1) * 8);
      break;

    case THREAT_CATEGORIES.CREDENTIAL_STUFFING:
      // Scales with volume of failed auth attempts
      const authFails = counts[SECURITY_EVENT_TYPES.AUTH_FAILED] || 1;
      score = Math.min(90, 40 + (authFails * 5));
      break;

    case THREAT_CATEGORIES.PRIVILEGE_ESCALATION:
      const rbacFails = counts[SECURITY_EVENT_TYPES.RBAC_DENIED] || 1;
      score = Math.min(85, 45 + (rbacFails * 8));
      break;

    case THREAT_CATEGORIES.ROUTE_SCAN:
      const scanHits = counts[SECURITY_EVENT_TYPES.ROUTE_SCAN] || 1;
      score = Math.min(80, 40 + (scanHits * 2));
      break;

    case THREAT_CATEGORIES.COMPANY_SUSPENSION_BREACH:
      score = 65;
      break;

    case THREAT_CATEGORIES.MULTI_VECTOR_SURGE:
      score = 92;
      break;

    default:
      score = 35;
  }

  // Multi-vector multiplier: if multiple threat categories seen from same IP
  if (totalDistinctTypes >= 3) {
    score = Math.min(98, score + 12);
  }

  // Determine severity tier
  let severity = 'low';
  if (score >= 85) severity = 'critical';
  else if (score >= 70) severity = 'high';
  else if (score >= 40) severity = 'medium';

  return { riskScore: Math.round(score), severity };
}

/**
 * Core incident correlation and aggregation processor.
 * Analyzes telemetry within a 15-minute sliding window and upserts incidents.
 *
 * @param {Object} data - Job payload or direct test trigger
 * @returns {Promise<Object|null>} Generated or updated incident record
 */
async function processSecurityIncident(data) {
  const ipAddress = data.ipAddress ? String(data.ipAddress).slice(0, 50) : null;
  const userId = data.userId ? String(data.userId) : null;
  const companyId = data.companyId ? String(data.companyId) : null;

  if (!ipAddress && !userId) {
    return null;
  }

  // 1. Fetch recent telemetry rows from the last 15 minutes for this IP/User
  const query = `
    SELECT id, company_id, user_id, event_type, severity, endpoint, metadata, created_at
    FROM security_events
    WHERE (
      ($1::varchar IS NOT NULL AND ip_address = $1)
      OR ($2::varchar IS NOT NULL AND user_id = $2)
    )
    AND created_at > NOW() - INTERVAL '15 minutes'
    ORDER BY created_at DESC
    LIMIT 100
  `;

  const eventRes = await pool.query(query, [ipAddress, userId]);
  const events = eventRes.rows;

  if (events.length === 0) {
    return null;
  }

  // 2. Count event frequency by type
  const counts = {};
  const eventIds = [];
  for (const ev of events) {
    counts[ev.event_type] = (counts[ev.event_type] || 0) + 1;
    eventIds.push(ev.id);
  }

  const distinctTypes = Object.keys(counts);

  // 3. Determine Primary Threat Category
  let threatCategory = null;
  let title = '';

  if (counts[SECURITY_EVENT_TYPES.ADMIN_UNAUTHORIZED]) {
    threatCategory = THREAT_CATEGORIES.SUPERADMIN_PROBE;
    title = `Unauthorized Super Admin Access Probing from ${ipAddress || userId}`;
  } else if (distinctTypes.length >= 2 && (counts[SECURITY_EVENT_TYPES.AUTH_FAILED] || counts[SECURITY_EVENT_TYPES.ROUTE_SCAN])) {
    threatCategory = THREAT_CATEGORIES.MULTI_VECTOR_SURGE;
    title = `Multi-Vector Security Surge from ${ipAddress || 'Client'} (${events.length} events)`;
  } else if ((counts[SECURITY_EVENT_TYPES.TENANT_MISMATCH] || 0) >= 1) {
    threatCategory = THREAT_CATEGORIES.CROSS_TENANT_IDOR;
    title = `Cross-Tenant Access Attempt Detected from ${ipAddress || userId}`;
  } else if ((counts[SECURITY_EVENT_TYPES.AUTH_FAILED] || 0) >= 3) {
    threatCategory = THREAT_CATEGORIES.CREDENTIAL_STUFFING;
    title = `Repeated Failed Login Attempts from ${ipAddress || 'Client'} (${counts[SECURITY_EVENT_TYPES.AUTH_FAILED]} attempts)`;
  } else if ((counts[SECURITY_EVENT_TYPES.RBAC_DENIED] || 0) >= 2) {
    threatCategory = THREAT_CATEGORIES.PRIVILEGE_ESCALATION;
    title = `Repeated Permission Denials from User ${userId || ipAddress}`;
  } else if ((counts[SECURITY_EVENT_TYPES.ROUTE_SCAN] || 0) >= 5) {
    threatCategory = THREAT_CATEGORIES.ROUTE_SCAN;
    title = `Automated Endpoint Probing / Scanning from ${ipAddress}`;
  } else if (counts[SECURITY_EVENT_TYPES.AUTH_COMPANY_SUSPENDED]) {
    threatCategory = THREAT_CATEGORIES.COMPANY_SUSPENSION_BREACH;
    title = `Suspended Company Access Attempt from ${ipAddress || userId}`;
  }

  // If no aggregated threshold exceeded, skip incident creation
  if (!threatCategory) {
    return null;
  }

  // 4. Calculate calibrated risk score & severity
  const { riskScore, severity } = calculateDeterministicRisk(threatCategory, counts, distinctTypes.length);

  // 5. Structure deterministic evidence payload
  const evidencePayload = {
    deterministicEvaluation: true,
    slidingWindowMinutes: 15,
    eventBreakdown: counts,
    correlatedEventIds: eventIds.slice(0, 20),
    totalEventsInWindow: events.length,
    latestEndpoints: [...new Set(events.map((e) => e.endpoint).filter(Boolean))].slice(0, 5),
    remediationGuide: getRemediationGuideline(threatCategory),
  };

  // 6. Check for existing active incident within the 15-minute window (Deduplication)
  const existingRes = await pool.query(
    `SELECT id, event_count, risk_score FROM security_incidents
     WHERE threat_category = $1
       AND (source_ip = $2 OR (target_user_id IS NOT NULL AND target_user_id = $3))
       AND status IN ('open', 'investigating')
       AND created_at > NOW() - INTERVAL '15 minutes'
     ORDER BY created_at DESC
     LIMIT 1`,
    [threatCategory, ipAddress, userId]
  );

  let incident = null;

  if (existingRes.rows.length > 0) {
    // Update existing incident
    const existing = existingRes.rows[0];
    const updateRes = await pool.query(
      `UPDATE security_incidents
       SET event_count = $1,
           risk_score = GREATEST(risk_score, $2),
           severity = $3,
           last_seen_at = NOW(),
           updated_at = NOW(),
           ai_analysis = $4
       WHERE id = $5
       RETURNING *`,
      [
        events.length,
        riskScore,
        severity,
        JSON.stringify(evidencePayload),
        existing.id,
      ]
    );
    incident = updateRes.rows[0];
    logger.info(`[SecurityWorker] Correlated existing incident ${incident.id} (Category: ${threatCategory}, Risk: ${incident.risk_score})`);
  } else {
    // Insert brand-new incident
    const insertRes = await pool.query(
      `INSERT INTO security_incidents
       (company_id, title, threat_category, status, severity, risk_score, source_ip, target_user_id, event_count, first_seen_at, last_seen_at, ai_analysis, created_at, updated_at)
       VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, NOW(), $10, NOW(), NOW())
       RETURNING *`,
      [
        companyId,
        title,
        threatCategory,
        severity,
        riskScore,
        ipAddress,
        userId,
        events.length,
        events[events.length - 1]?.created_at || new Date(),
        JSON.stringify(evidencePayload),
      ]
    );
    incident = insertRes.rows[0];
    logger.info(`[SecurityWorker] Created new incident ${incident.id} (Category: ${threatCategory}, Risk: ${riskScore})`);
  }

  // 7. Deterministic Remediation Policy Evaluation & Safe Automation
  try {
    const { applyRemediationPolicy } = require('../utils/securityPolicyEngine');
    const { executeSecurityAction } = require('../utils/securityActionExecutor');
    const actions = await applyRemediationPolicy(incident);

    // Auto-execute ONLY safe, non-destructive actions
    for (const act of actions) {
      if (act.is_automated && act.approval_status !== 'executed') {
        await executeSecurityAction(act.id, 'security-policy-engine');
      }
    }
  } catch (policyErr) {
    logger.warn(`[SecurityWorker] Policy application non-fatal warning: ${policyErr.message}`);
  }

  // 8. Out-of-band Critical Incident Notification (Super Admin Only)
  if (incident.severity === 'critical') {
    try {
      const { notifySuperAdminCriticalIncident } = require('../utils/securityNotifier');
      setImmediate(() => {
        notifySuperAdminCriticalIncident({ incident }).catch((err) => {
          logger.warn(`[SecurityWorker] Notification dispatch warning: ${err.message}`);
        });
      });
    } catch (notifErr) {
      logger.warn(`[SecurityWorker] Notification helper warning: ${notifErr.message}`);
    }
  }

  return incident;
}

/**
 * Returns deterministic remediation guidelines based on threat category.
 */
function getRemediationGuideline(category) {
  switch (category) {
    case THREAT_CATEGORIES.SUPERADMIN_PROBE:
      return 'Verify source IP credentials. Invalidate active token if caller is non-superadmin.';
    case THREAT_CATEGORIES.CROSS_TENANT_IDOR:
      return 'Review access logs for target tenant ID. Check if client session was hijacked or compromised.';
    case THREAT_CATEGORIES.CREDENTIAL_STUFFING:
      return 'Enforce rate-limiting on origin IP. Require CAPTCHA or OTP on next authentication.';
    case THREAT_CATEGORIES.PRIVILEGE_ESCALATION:
      return 'Inspect user role assignment and verify client interface permissions.';
    case THREAT_CATEGORIES.ROUTE_SCAN:
      return 'Monitor origin IP. Apply temporary firewall throttle if scanning continues.';
    case THREAT_CATEGORIES.MULTI_VECTOR_SURGE:
      return 'High-priority suspicious activity. Flag for Super Admin review and consider temporary IP quarantine.';
    default:
      return 'Monitor security telemetry for further anomalous behavior.';
  }
}

/**
 * Initialize BullMQ Worker instance if Redis connection is present.
 */
let securityWorker = null;
if (redisConnection) {
  securityWorker = new Worker(
    'security-detection',
    async (job) => {
      logger.info(`🛡️ [SecurityWorker] Processing job ${job.id} (Trigger: ${job.data?.trigger || 'event'})`);
      try {
        await processSecurityIncident(job.data);
      } catch (err) {
        logger.error(`❌ [SecurityWorker] Job ${job.id} failed:`, err.message);
        throw err;
      }
    },
    {
      connection: redisConnection,
      concurrency: 5,
    }
  );

  securityWorker.on('failed', (job, err) => {
    logger.warn(`⚠️ [SecurityWorker] Job ${job?.id} failed with error: ${err.message}`);
  });
}

module.exports = {
  processSecurityIncident,
  calculateDeterministicRisk,
  THREAT_CATEGORIES,
  securityWorker,
};
