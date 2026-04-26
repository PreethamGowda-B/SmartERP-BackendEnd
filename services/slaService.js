/**
 * services/slaService.js
 *
 * SLA (Service Level Agreement) System
 *
 * Hardening (Sections 5, 9, 11):
 *   - Correct defaults: max_accept_time=15min, max_completion_time=240min (4 hours)
 *   - getSlaConfig never throws — always returns safe defaults
 *   - SLA checks wrapped in try/catch per-job — one bad row never stops the batch
 *   - Audit log retention: purges entries older than 90 days (Section 9)
 *   - All DB errors caught and logged, never propagated
 *
 * SLA timing (corrected per spec):
 *   Acceptance SLA: assigned_at → accepted_at
 *   Completion SLA: accepted_at → completed_at
 */

'use strict';

const { pool } = require('../db');
const auditService = require('./auditService');

// Section 5: Correct defaults
const SLA_DEFAULTS = {
  max_accept_time: 15,    // minutes: assigned_at → accepted_at
  max_completion_time: 240, // minutes: accepted_at → completed_at (4 hours)
};

const CHECK_INTERVAL_MS    = 2 * 60 * 1000;  // 2 minutes
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const AUDIT_RETENTION_DAYS  = 90;

let _slaTimer       = null;
let _retentionTimer = null;

// ─── Get SLA config — never throws (Section 5) ───────────────────────────────
async function getSlaConfig(companyId) {
  try {
    if (!companyId) return { ...SLA_DEFAULTS };

    const result = await pool.query(
      `SELECT max_accept_time, max_completion_time
       FROM sla_configs
       WHERE company_id = $1 AND is_active = TRUE
       LIMIT 1`,
      [companyId]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        max_accept_time:     parseInt(row.max_accept_time)     || SLA_DEFAULTS.max_accept_time,
        max_completion_time: parseInt(row.max_completion_time) || SLA_DEFAULTS.max_completion_time,
      };
    }

    return { ...SLA_DEFAULTS };
  } catch (err) {
    // Section 5: never crash — return defaults
    console.warn('getSlaConfig error (using defaults):', err.message);
    return { ...SLA_DEFAULTS };
  }
}

// ─── Check acceptance SLA breaches ───────────────────────────────────────────
// Acceptance SLA: assigned_at → accepted_at
async function checkAcceptanceBreaches() {
  try {
    const result = await pool.query(
      `SELECT j.id, j.company_id, j.assigned_at, j.title
       FROM jobs j
       WHERE j.approval_status = 'approved'
         AND j.assigned_to IS NOT NULL
         AND j.employee_status = 'assigned'
         AND j.accepted_at IS NULL
         AND j.sla_accept_breached = FALSE
         AND j.assigned_at IS NOT NULL
         AND j.status NOT IN ('completed', 'cancelled')`
    );

    for (const job of result.rows) {
      try {
        const config = await getSlaConfig(job.company_id);
        const minutesElapsed = (Date.now() - new Date(job.assigned_at).getTime()) / 60_000;

        if (minutesElapsed > config.max_accept_time) {
          await pool.query(
            `UPDATE jobs
             SET sla_accept_breached  = TRUE,
                 sla_accept_breach_at = NOW()
             WHERE id = $1 AND sla_accept_breached = FALSE`,
            [job.id]
          );

          auditService.log({
            companyId: job.company_id,
            actorType: 'system',
            actionType: 'sla_accept_breach',
            entityType: 'job',
            entityId: job.id,
            newValue: {
              job_title: job.title,
              minutes_elapsed: Math.round(minutesElapsed),
              max_accept_time: config.max_accept_time,
            },
          }).catch(() => {});

          console.warn(
            `⚠️  SLA acceptance breach: Job ${job.id} — ${Math.round(minutesElapsed)}min / limit ${config.max_accept_time}min`
          );
        }
      } catch (jobErr) {
        // Section 11: one bad job never stops the batch
        console.error(`SLA acceptance check error for job ${job.id}:`, jobErr.message);
      }
    }
  } catch (err) {
    console.error('SLA acceptance batch error:', err.message);
  }
}

// ─── Check completion SLA breaches ───────────────────────────────────────────
// Completion SLA: accepted_at → completed_at
async function checkCompletionBreaches() {
  try {
    const result = await pool.query(
      `SELECT j.id, j.company_id, j.accepted_at, j.title
       FROM jobs j
       WHERE j.approval_status = 'approved'
         AND j.employee_status = 'accepted'
         AND j.completed_at IS NULL
         AND j.sla_completion_breached = FALSE
         AND j.accepted_at IS NOT NULL
         AND j.status NOT IN ('completed', 'cancelled')`
    );

    for (const job of result.rows) {
      try {
        const config = await getSlaConfig(job.company_id);
        const minutesElapsed = (Date.now() - new Date(job.accepted_at).getTime()) / 60_000;

        if (minutesElapsed > config.max_completion_time) {
          await pool.query(
            `UPDATE jobs
             SET sla_completion_breached  = TRUE,
                 sla_completion_breach_at = NOW()
             WHERE id = $1 AND sla_completion_breached = FALSE`,
            [job.id]
          );

          auditService.log({
            companyId: job.company_id,
            actorType: 'system',
            actionType: 'sla_completion_breach',
            entityType: 'job',
            entityId: job.id,
            newValue: {
              job_title: job.title,
              minutes_elapsed: Math.round(minutesElapsed),
              max_completion_time: config.max_completion_time,
            },
          }).catch(() => {});

          console.warn(
            `⚠️  SLA completion breach: Job ${job.id} — ${Math.round(minutesElapsed)}min / limit ${config.max_completion_time}min`
          );
        }
      } catch (jobErr) {
        console.error(`SLA completion check error for job ${job.id}:`, jobErr.message);
      }
    }
  } catch (err) {
    console.error('SLA completion batch error:', err.message);
  }
}

// ─── Section 9: Audit log retention — purge entries older than 90 days ───────
async function purgeOldAuditLogs() {
  try {
    const result = await pool.query(
      `DELETE FROM audit_logs
       WHERE created_at < NOW() - INTERVAL '${AUDIT_RETENTION_DAYS} days'`
    );
    if (result.rowCount > 0) {
      console.log(`🧹 Audit log retention: purged ${result.rowCount} entries older than ${AUDIT_RETENTION_DAYS} days`);
    }
  } catch (err) {
    // Non-blocking — never crash the server
    console.error('Audit log retention error:', err.message);
  }
}

// ─── Get SLA metrics for owner dashboard ─────────────────────────────────────
async function getSlaMetrics(companyId, { startDate, endDate } = {}) {
  try {
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end   = endDate   || new Date();

    const result = await pool.query(
      `SELECT
         COUNT(*)                                                        AS total_jobs,
         COUNT(*) FILTER (WHERE sla_accept_breached = TRUE)             AS accept_breaches,
         COUNT(*) FILTER (WHERE sla_completion_breached = TRUE)         AS completion_breaches,
         COUNT(*) FILTER (WHERE sla_accept_breached = FALSE
                            AND accepted_at IS NOT NULL)                AS on_time_accepts,
         COUNT(*) FILTER (WHERE sla_completion_breached = FALSE
                            AND completed_at IS NOT NULL)               AS on_time_completions,
         ROUND(AVG(
           CASE WHEN accepted_at IS NOT NULL AND assigned_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (accepted_at - assigned_at)) / 60
           END
         )::numeric, 1)                                                 AS avg_accept_time_min,
         ROUND(AVG(
           CASE WHEN completed_at IS NOT NULL AND accepted_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (completed_at - accepted_at)) / 60
           END
         )::numeric, 1)                                                 AS avg_completion_time_min
       FROM jobs
       WHERE company_id = $1
         AND approval_status = 'approved'
         AND created_at BETWEEN $2 AND $3`,
      [companyId, start, end]
    );

    const row = result.rows[0];
    const total              = parseInt(row.total_jobs)          || 0;
    const acceptBreaches     = parseInt(row.accept_breaches)     || 0;
    const completionBreaches = parseInt(row.completion_breaches) || 0;
    const totalBreaches      = acceptBreaches + completionBreaches;

    return {
      total_jobs:              total,
      accept_breaches:         acceptBreaches,
      completion_breaches:     completionBreaches,
      on_time_accepts:         parseInt(row.on_time_accepts)      || 0,
      on_time_completions:     parseInt(row.on_time_completions)  || 0,
      accept_breach_rate:      total > 0 ? ((acceptBreaches     / total) * 100).toFixed(1) : '0.0',
      completion_breach_rate:  total > 0 ? ((completionBreaches / total) * 100).toFixed(1) : '0.0',
      avg_accept_time_min:     row.avg_accept_time_min     || null,
      avg_completion_time_min: row.avg_completion_time_min || null,
      sla_compliance_rate:     total > 0 ? (((total - totalBreaches) / total) * 100).toFixed(1) : '100.0',
    };
  } catch (err) {
    console.error('getSlaMetrics error:', err.message);
    // Return safe empty metrics rather than crashing
    return {
      total_jobs: 0, accept_breaches: 0, completion_breaches: 0,
      accept_breach_rate: '0.0', completion_breach_rate: '0.0',
      sla_compliance_rate: '100.0', avg_accept_time_min: null, avg_completion_time_min: null,
    };
  }
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────
function start() {
  if (_slaTimer) return;

  console.log(`📋 SLA service started (check interval: ${CHECK_INTERVAL_MS / 1000}s)`);

  _slaTimer = setInterval(async () => {
    await checkAcceptanceBreaches();
    await checkCompletionBreaches();
  }, CHECK_INTERVAL_MS);

  // Run immediately on start
  checkAcceptanceBreaches();
  checkCompletionBreaches();

  // Section 9: Audit log retention — run once per day
  _retentionTimer = setInterval(purgeOldAuditLogs, RETENTION_INTERVAL_MS);
  purgeOldAuditLogs(); // Run once on startup
}

function stop() {
  if (_slaTimer) {
    clearInterval(_slaTimer);
    _slaTimer = null;
  }
  if (_retentionTimer) {
    clearInterval(_retentionTimer);
    _retentionTimer = null;
  }
  console.log('📋 SLA service stopped');
}

module.exports = {
  start, stop,
  getSlaMetrics, getSlaConfig,
  checkAcceptanceBreaches, checkCompletionBreaches,
  purgeOldAuditLogs,
};
