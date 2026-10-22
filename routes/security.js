/**
 * routes/security.js
 *
 * Super Admin Defensive Security Center API Routes for SmartERP.
 * Strictly protected server-side by authenticateToken + authenticateSuperAdmin.
 *
 * All endpoints return sanitized, credential-redacted security intelligence
 * exclusively to authenticated Super Administrators.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { authenticateSuperAdmin } = require('../middleware/adminMiddleware');
const { redactSensitiveData } = require('../utils/promptShield');
const { analyzeIncidentWithAI } = require('../ai/securityAnalyst');
const { executeSecurityAction, revertSecurityAction } = require('../utils/securityActionExecutor');
const logger = require('../utils/logger');

// Strict Security API Rate Limiter (60 requests per 15 minutes)
const securityApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many security administrative requests, please try again later.' },
});

// Enforce Global Route Protection on ALL Security Endpoints
router.use(securityApiLimiter);
router.use(authenticateToken);
router.use(authenticateSuperAdmin);

/**
 * GET /api/v1/superadmin/security/health
 * Diagnostic health endpoint for 24/7 Security Background Worker and SOC operations.
 */
router.get('/health', async (req, res) => {
  try {
    const { redisClient } = require('../utils/redis');
    const { securityWorker } = require('../jobs/securityWorker');

    // 1. Database connectivity
    let dbStatus = 'healthy';
    let dbLatencyMs = null;
    const dbStart = Date.now();
    try {
      await pool.query('SELECT 1');
      dbLatencyMs = Date.now() - dbStart;
    } catch (e) {
      dbStatus = 'degraded';
    }

    // 2. Redis connectivity
    const redisStatus = redisClient?.status === 'ready' ? 'connected' : (redisClient ? redisClient.status : 'disconnected');

    // 3. BullMQ Worker state
    const workerRunning = Boolean(securityWorker && !securityWorker.closing && !securityWorker.closed);

    // 4. Latest Security Event & Incident telemetry
    const lastEventRes = await pool.query('SELECT created_at FROM security_events ORDER BY created_at DESC LIMIT 1').catch(() => ({ rows: [] }));
    const lastIncidentRes = await pool.query('SELECT id, threat_category, severity, created_at FROM security_incidents ORDER BY created_at DESC LIMIT 1').catch(() => ({ rows: [] }));

    // 5. Threat summary
    const summaryRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('open', 'investigating')) as active_incidents,
        COUNT(*) FILTER (WHERE severity = 'critical' AND status IN ('open', 'investigating')) as critical_active
      FROM security_incidents
    `).catch(() => ({ rows: [{ active_incidents: 0, critical_active: 0 }] }));

    const activeCount = parseInt(summaryRes.rows[0]?.active_incidents || '0', 10);
    const criticalCount = parseInt(summaryRes.rows[0]?.critical_active || '0', 10);

    let systemThreatPosture = 'NORMAL';
    if (criticalCount > 0) systemThreatPosture = 'CRITICAL';
    else if (activeCount > 0) systemThreatPosture = 'ELEVATED';

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      worker: {
        securityWorkerActive: workerRunning,
        queueName: 'security-detection',
        concurrency: 5,
        redisStatus,
      },
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
      },
      telemetry: {
        lastEventAt: lastEventRes.rows[0]?.created_at || null,
        lastIncidentAt: lastIncidentRes.rows[0]?.created_at || null,
        lastIncident: lastIncidentRes.rows[0] || null,
      },
      posture: {
        threatLevel: systemThreatPosture,
        activeIncidents: activeCount,
        criticalIncidents: criticalCount,
      },
    });
  } catch (err) {
    logger.error(`[SecurityHealth] Diagnostic error: ${err.message}`);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/v1/superadmin/security/dashboard
 * Retrieves high-level security posture, active incidents, and threat summaries.
 */
router.get('/dashboard', async (req, res) => {
  try {
    const statsRes = await pool.query(`
      SELECT
        COUNT(*) as total_incidents,
        COUNT(*) FILTER (WHERE status = 'open') as open_incidents,
        COUNT(*) FILTER (WHERE status = 'investigating') as investigating_incidents,
        COUNT(*) FILTER (WHERE severity = 'critical') as critical_incidents,
        COUNT(*) FILTER (WHERE severity = 'high') as high_incidents,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as incidents_last_24h
      FROM security_incidents
    `);

    const actionsRes = await pool.query(`
      SELECT
        COUNT(*) as total_actions,
        COUNT(*) FILTER (WHERE approval_status = 'pending') as pending_approvals,
        COUNT(*) FILTER (WHERE approval_status = 'executed') as executed_actions
      FROM security_actions
    `);

    const recentIncidents = await pool.query(`
      SELECT id, company_id, title, threat_category, status, severity, risk_score, source_ip, target_user_id, event_count, created_at
      FROM security_incidents
      ORDER BY created_at DESC
      LIMIT 6
    `);

    const rawStats = statsRes.rows[0] || {};
    const rawActions = actionsRes.rows[0] || {};

    const openCount = parseInt(rawStats.open_incidents || '0', 10);
    const investigatingCount = parseInt(rawStats.investigating_incidents || '0', 10);
    const criticalCount = parseInt(rawStats.critical_incidents || '0', 10);
    const highCount = parseInt(rawStats.high_incidents || '0', 10);
    const pendingApprovals = parseInt(rawActions.pending_approvals || '0', 10);
    const totalCount = parseInt(rawStats.total_incidents || '0', 10);

    let threatLevel = 'NORMAL';
    if (criticalCount > 0) threatLevel = 'CRITICAL';
    else if (highCount > 0) threatLevel = 'HIGH';
    else if (openCount > 0) threatLevel = 'ELEVATED';

    const formattedStats = {
      healthStatus: {
        threatLevel,
        activeIncidents: openCount + investigatingCount,
        criticalCount,
        highCount,
        pendingApprovals,
      },
      incidentBreakdown: {
        bySeverity: {
          critical: criticalCount,
          high: highCount,
          medium: 0,
          low: 0,
        },
        byCategory: {},
        byStatus: {
          open: openCount,
          investigating: investigatingCount,
        }
      },
      metrics24h: {
        eventsIngested: parseInt(rawStats.incidents_last_24h || '0', 10),
        automatedActionsExecuted: parseInt(rawActions.executed_actions || '0', 10),
        mitigatedThreats: Math.max(0, totalCount - (openCount + investigatingCount)),
      },
      total_incidents: totalCount,
      open_incidents: openCount,
      critical_incidents: criticalCount,
    };

    return res.json({
      success: true,
      stats: formattedStats,
      actionsSummary: rawActions,
      recentIncidents: redactSensitiveData(recentIncidents.rows),
    });
  } catch (err) {
    logger.error(`[SecurityAPI] Dashboard fetch error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to fetch security dashboard metrics.' });
  }
});

/**
 * GET /api/v1/superadmin/security/incidents
 * Paginated query for security incidents with filtering.
 */
router.get('/incidents', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 15));
    const offset = (page - 1) * limit;

    const { status, severity, threatCategory } = req.query;
    const conditions = [];
    const values = [];

    if (status) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    if (severity) {
      values.push(severity);
      conditions.push(`severity = $${values.length}`);
    }
    if (threatCategory) {
      values.push(threatCategory);
      conditions.push(`threat_category = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM security_incidents ${whereClause}`, values);
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const dataQuery = `
      SELECT id, company_id, title, threat_category, status, severity, risk_score, source_ip, target_user_id, event_count, first_seen_at, last_seen_at, created_at
      FROM security_incidents
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `;

    const dataRes = await pool.query(dataQuery, [...values, limit, offset]);

    return res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      incidents: redactSensitiveData(dataRes.rows),
    });
  } catch (err) {
    logger.error(`[SecurityAPI] Incidents list error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to fetch security incidents.' });
  }
});

/**
 * GET /api/v1/superadmin/security/incidents/:id
 * Retrieves full incident details, correlated telemetry, and associated actions.
 */
router.get('/incidents/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const incRes = await pool.query(
      `SELECT id, company_id, title, threat_category, status, severity, risk_score, source_ip, target_user_id, event_count, first_seen_at, last_seen_at, ai_analysis, created_at, updated_at
       FROM security_incidents WHERE id = $1`,
      [id]
    );

    if (incRes.rows.length === 0) {
      return res.status(404).json({ message: 'Security incident not found.' });
    }

    const incident = incRes.rows[0];

    // Fetch correlated events
    const eventsRes = await pool.query(
      `SELECT id, company_id, user_id, event_type, severity, endpoint, http_method, status_code, metadata, created_at
       FROM security_events
       WHERE (
         ($1::varchar IS NOT NULL AND ip_address = $1)
         OR ($2::varchar IS NOT NULL AND user_id = $2)
       )
       ORDER BY created_at DESC
       LIMIT 30`,
      [incident.source_ip, incident.target_user_id]
    );

    // Fetch remediation actions
    const actionsRes = await pool.query(
      `SELECT id, incident_id, action_type, is_automated, approval_status, executed_by, reverted_at, details, created_at
       FROM security_actions
       WHERE incident_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    return res.json({
      success: true,
      incident: redactSensitiveData(incident),
      correlatedEvents: redactSensitiveData(eventsRes.rows),
      actions: redactSensitiveData(actionsRes.rows),
    });
  } catch (err) {
    logger.error(`[SecurityAPI] Incident details fetch error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to retrieve incident details.' });
  }
});

/**
 * POST /api/v1/superadmin/security/incidents/:id/analyze
 * Triggers read-only Gemini Security Analyst enrichment on demand.
 */
router.post('/incidents/:id/analyze', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await analyzeIncidentWithAI({ incidentId: id, timeoutMs: 10000 });

    if (!result.success) {
      return res.status(400).json({ message: result.error || 'AI analysis could not be completed.' });
    }

    return res.json({
      success: true,
      message: 'AI threat enrichment completed successfully.',
      enrichment: result.enrichment,
    });
  } catch (err) {
    logger.error(`[SecurityAPI] AI analysis trigger error: ${err.message}`);
    return res.status(500).json({ message: 'Internal error during security AI analysis.' });
  }
});

/**
 * GET /api/v1/superadmin/security/actions
 * Lists all proposed, pending, and executed security actions.
 */
router.get('/actions', async (req, res) => {
  try {
    const { status, incidentId } = req.query;
    const conditions = [];
    const values = [];

    if (status) {
      values.push(status);
      conditions.push(`approval_status = $${values.length}`);
    }
    if (incidentId) {
      values.push(incidentId);
      conditions.push(`incident_id = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const actionsRes = await pool.query(
      `SELECT id, incident_id, company_id, action_type, is_automated, approval_status, executed_by, reverted_at, details, created_at
       FROM security_actions
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT 50`,
      values
    );

    return res.json({
      success: true,
      actions: redactSensitiveData(actionsRes.rows),
    });
  } catch (err) {
    logger.error(`[SecurityAPI] Actions list error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to fetch security actions.' });
  }
});

/**
 * POST /api/v1/superadmin/security/actions/:id/approve
 * Super Admin approves and triggers execution of a pending sensitive action.
 */
router.post('/actions/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const superAdminId = req.user.email || req.user.id || 'super_admin';

    // 1. Check action exists and is pending
    const checkRes = await pool.query(
      `SELECT id, approval_status FROM security_actions WHERE id = $1`,
      [id]
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({ message: 'Security action not found.' });
    }

    if (checkRes.rows[0].approval_status !== 'pending') {
      return res.status(400).json({ message: `Action is already in '${checkRes.rows[0].approval_status}' state.` });
    }

    // 2. Mark approved and execute
    await pool.query(
      `UPDATE security_actions SET approval_status = 'approved', executed_by = $1 WHERE id = $2`,
      [superAdminId, id]
    );

    const execResult = await executeSecurityAction(id, superAdminId);

    if (!execResult.success) {
      return res.status(500).json({ message: `Action execution failed: ${execResult.error}` });
    }

    return res.json({
      success: true,
      message: 'Security action approved and executed successfully.',
      action: redactSensitiveData(execResult.action),
    });
  } catch (err) {
    logger.error(`[SecurityAPI] Action approval error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to approve security action.' });
  }
});

/**
 * POST /api/v1/superadmin/security/actions/:id/reject
 * Super Admin rejects a pending sensitive security action.
 */
router.post('/actions/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const superAdminId = req.user.email || req.user.id || 'super_admin';

    const checkRes = await pool.query(`SELECT id, approval_status FROM security_actions WHERE id = $1`, [id]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ message: 'Security action not found.' });
    }

    const updatedRes = await pool.query(
      `UPDATE security_actions
       SET approval_status = 'rejected',
           executed_by = $1,
           details = jsonb_set(COALESCE(details, '{}'::jsonb), '{rejectedBy}', $2::jsonb)
       WHERE id = $3
       RETURNING *`,
      [superAdminId, JSON.stringify(superAdminId), id]
    );

    return res.json({
      success: true,
      message: 'Security action rejected.',
      action: redactSensitiveData(updatedRes.rows[0]),
    });
  } catch (err) {
    logger.error(`[SecurityAPI] Action rejection error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to reject security action.' });
  }
});

/**
 * POST /api/v1/superadmin/security/actions/:id/revert
 * Super Admin rolls back a previously executed security action.
 */
router.post('/actions/:id/revert', async (req, res) => {
  try {
    const { id } = req.params;
    const superAdminId = req.user.email || req.user.id || 'super_admin';

    const revertResult = await revertSecurityAction(id, superAdminId);
    if (!revertResult.success) {
      return res.status(400).json({ message: revertResult.error || 'Failed to revert security action.' });
    }

    return res.json({
      success: true,
      message: 'Security action successfully rolled back / reverted.',
      action: redactSensitiveData(revertResult.action),
    });
  } catch (err) {
    logger.error(`[SecurityAPI] Action rollback error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to roll back security action.' });
  }
});

module.exports = router;
