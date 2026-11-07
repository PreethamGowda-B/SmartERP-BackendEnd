const { pool } = require("../../db");
const crypto = require('node:crypto');

function resolveAuditHmacKey() {
  const dedicated = Boolean(process.env.AI_AUDIT_HMAC_SECRET);
  const rootSecret = process.env.AI_AUDIT_HMAC_SECRET || process.env.JWT_SECRET;
  if (rootSecret) {
    const key = crypto.hkdfSync(
      'sha256',
      Buffer.from(rootSecret, 'utf8'),
      Buffer.from('smarterp-ai-audit-hmac-v1', 'utf8'),
      Buffer.from('approved-audit-fingerprint', 'utf8'),
      32,
    );
    return { key, keyId: dedicated ? 'dedicated-v1' : 'jwt-derived-v1' };
  }
  const error = new Error('AI audit fingerprint key is not configured.');
  error.code = 'AI_AUDIT_HMAC_NOT_CONFIGURED';
  throw error;
}

function keyedDigest(purpose, value, key = resolveAuditHmacKey().key) {
  return crypto.createHmac('sha256', key)
    .update(`smarterp:ai-audit:${purpose}:v1\0`)
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function approvalAuditParams(toolName, params = {}, keyConfig = resolveAuditHmacKey()) {
  const safeFields = {
    create_job: ['priority'],
    create_employee: ['position', 'department'],
    create_customer: [],
    calculate_payroll: ['month', 'year'],
  }[toolName] || [];
  const fields = {};
  for (const key of safeFields) {
    const value = params[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) fields[key] = String(value).slice(0, 80);
  }
  return {
    payload_hmac_sha256: keyedDigest('approved-action-payload', params, keyConfig.key),
    hmac_key_id: keyConfig.keyId,
    supplied_fields: Object.keys(params).filter((key) => key !== 'confirmed').sort(),
    safe_fields: fields,
  };
}

class MetricsService {
  /**
   * Writes AI action execution audit record to PostgreSQL table.
   * Extended with portal, module, plan_tier, model_scope, latency_ms, confidence_score, blocked fields.
   */
  static async logAIAuditEvent({
    userContext,
    toolName,
    params,
    status = "SUCCESS",
    error = null,
    portal = null,
    module = null,
    planTier = null,
    modelScope = null,
    latencyMs = null,
    confidenceScore = null,
    blocked = false,
    promptPreview = null,
    provider = null,
    model = null,
  }) {
    try {
      return await MetricsService.writeAIAuditEvent({
        userContext, toolName, params, status, error, portal, module, planTier,
        modelScope, latencyMs, confidenceScore, blocked, promptPreview, provider, model,
      });
    } catch (err) {
      console.warn("⚠️ MetricsService audit logging warning:", {
        code: typeof err?.code === 'string' ? err.code.slice(0, 40) : null,
        name: typeof err?.name === 'string' ? err.name.slice(0, 60) : 'Error',
      });
    }
  }

  // Unlike best-effort telemetry, approved writes must share their transaction
  // with this insert so a missing audit record also rolls back the ERP change.
  static async writeAIAuditEvent({ queryable = pool, ...event }) {
      const {
        userContext, toolName, params, status = 'SUCCESS', error = null, portal = null,
        module = null, planTier = null, modelScope = null, latencyMs = null,
        confidenceScore = null, blocked = false, promptPreview = null, provider = null, model = null,
      } = event;
      const companyId = userContext?.user?.companyId || userContext?.user?.company_id || "0";
      const userId = userContext?.user?.id || "0";
      const role = userContext?.user?.role || "user";
      const resolvedPortal = portal || userContext?.ui?.portal || null;
      const resolvedModule = module || userContext?.ui?.module || null;

      const auditHmacKey = resolveAuditHmacKey();
      const auditParams = approvalAuditParams(toolName, params || {}, auditHmacKey);
      const promptDigest = promptPreview
        ? `hmac-sha256:${keyedDigest('prompt-preview', String(promptPreview), auditHmacKey.key)}`
        : null;
      await queryable.query(
        `INSERT INTO ai_audit_logs (
          company_id, user_id, user_role, tool_name, action_params, status, error_message,
          portal, module, plan_tier, model_scope, latency_ms, confidence_score, blocked, prompt_preview,
          provider, model,
          created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())`,
        [
          String(companyId),
          String(userId),
          role,
          toolName,
          JSON.stringify(auditParams),
          status,
          error ? `${String(error.name || 'Error').slice(0, 40)}:${String(error.code || 'unknown').slice(0, 40)}` : null,
          resolvedPortal,
          resolvedModule,
          planTier,
          modelScope,
          latencyMs,
          confidenceScore,
          blocked,
          promptDigest,
          provider,
          model,
        ]
      );
  }

  /**
   * Logs Pro-capability rule-based interceptions for audit and tuning.
   */
  static async logAIInterception({ userContext, prompt, matchedKeyword, planTier }) {
    try {
      const companyId = userContext?.user?.companyId || "0";
      const userId = userContext?.user?.id || "0";
      const role = userContext?.user?.role || "user";
      const auditHmacKey = resolveAuditHmacKey();

      await pool.query(
        `INSERT INTO ai_audit_logs (
          company_id, user_id, user_role, tool_name, action_params, status, error_message,
          plan_tier, blocked, prompt_preview,
          created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [
          String(companyId),
          String(userId),
          role,
          "PRO_PLAN_INTERCEPTION",
          JSON.stringify({
            prompt_hmac_sha256: keyedDigest('interception-prompt', String(prompt || ''), auditHmacKey.key),
            prompt_length: String(prompt || '').length,
            matched_keyword_hmac_sha256: keyedDigest('interception-keyword', String(matchedKeyword || ''), auditHmacKey.key),
            planTier,
            hmac_key_id: auditHmacKey.keyId,
          }),
          "INTERCEPTED",
          'AI rule interception',
          planTier,
          true,
          prompt ? `hmac-sha256:${keyedDigest('prompt-preview', String(prompt), auditHmacKey.key)}` : null,
        ]
      );
    } catch (err) {
      console.warn("⚠️ MetricsService logAIInterception warning:", {
        code: typeof err?.code === 'string' ? err.code.slice(0, 40) : null,
        name: typeof err?.name === 'string' ? err.name.slice(0, 60) : 'Error',
      });
    }
  }

  /**
   * Returns aggregated AI usage statistics for the Super Admin AI Operations dashboard.
   * @returns {Promise<Object>} stats
   */
  static async getAIStats() {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

      const [
        todayRes,
        monthRes,
        topToolRes,
        avgLatencyRes,
        blockedRes,
        planBreakdownRes,
        topCompanyRes,
        scopeBreakdownRes,
      ] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM ai_audit_logs WHERE created_at >= $1`, [today]),
        pool.query(`SELECT COUNT(*) FROM ai_audit_logs WHERE created_at >= $1`, [monthStart]),
        pool.query(`SELECT tool_name, COUNT(*) as cnt FROM ai_audit_logs WHERE tool_name NOT IN ('PRO_PLAN_INTERCEPTION') GROUP BY tool_name ORDER BY cnt DESC LIMIT 1`),
        pool.query(`SELECT AVG(latency_ms) as avg_latency FROM ai_audit_logs WHERE latency_ms IS NOT NULL AND created_at >= $1`, [monthStart]),
        pool.query(`SELECT COUNT(*) FROM ai_audit_logs WHERE blocked = TRUE AND created_at >= $1`, [monthStart]),
        pool.query(`SELECT plan_tier, COUNT(*) as cnt FROM ai_audit_logs WHERE plan_tier IS NOT NULL AND created_at >= $1 GROUP BY plan_tier`, [monthStart]),
        pool.query(`SELECT company_id, COUNT(*) as cnt FROM ai_audit_logs WHERE created_at >= $1 GROUP BY company_id ORDER BY cnt DESC LIMIT 10`, [monthStart]),
        pool.query(`SELECT model_scope, COUNT(*) as cnt FROM ai_audit_logs WHERE model_scope IS NOT NULL AND created_at >= $1 GROUP BY model_scope ORDER BY cnt DESC`, [monthStart]),
      ]);

      const planBreakdown = {};
      planBreakdownRes.rows.forEach((r) => {
        if (r.plan_tier) planBreakdown[r.plan_tier] = parseInt(r.cnt);
      });

      return {
        requestsToday: parseInt(todayRes.rows[0]?.count || 0),
        requestsThisMonth: parseInt(monthRes.rows[0]?.count || 0),
        mostUsedTool: topToolRes.rows[0]?.tool_name || null,
        avgLatencyMs: Math.round(parseFloat(avgLatencyRes.rows[0]?.avg_latency || 0)),
        blockedRequests: parseInt(blockedRes.rows[0]?.count || 0),
        planBreakdown,
        topCompaniesByUsage: topCompanyRes.rows.map((r) => ({
          companyId: r.company_id,
          requests: parseInt(r.cnt),
        })),
        scopeBreakdown: scopeBreakdownRes.rows.map((r) => ({
          scope: r.model_scope,
          count: parseInt(r.cnt),
        })),
      };
    } catch (err) {
      console.error("⚠️ MetricsService.getAIStats error:", {
        code: typeof err?.code === 'string' ? err.code.slice(0, 40) : null,
        name: typeof err?.name === 'string' ? err.name.slice(0, 60) : 'Error',
      });
      return {
        requestsToday: 0,
        requestsThisMonth: 0,
        mostUsedTool: null,
        avgLatencyMs: 0,
        blockedRequests: 0,
        planBreakdown: {},
        topCompaniesByUsage: [],
        scopeBreakdown: [],
      };
    }
  }

  /**
   * Returns paginated AI audit log entries for the Super Admin dashboard.
   */
  static async getAuditLogs({ page = 1, limit = 50, companyId = null, status = null, fromDate = null } = {}) {
    try {
      const offset = (page - 1) * limit;
      const conditions = [];
      const params = [];
      let idx = 1;

      if (companyId) { conditions.push(`company_id = $${idx++}`); params.push(String(companyId)); }
      if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
      if (fromDate) { conditions.push(`created_at >= $${idx++}`); params.push(fromDate); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const [rows, countRes] = await Promise.all([
        pool.query(
          `SELECT id, company_id, user_id, user_role, tool_name, action_params, status,
                  error_message, portal, module, plan_tier, model_scope, latency_ms,
                  confidence_score, blocked, prompt_preview, provider, model, created_at
             FROM public.ai_audit_logs ${where}
            ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM ai_audit_logs ${where}`, params),
      ]);

      return {
        logs: rows.rows,
        total: parseInt(countRes.rows[0]?.count || 0),
        page,
        limit,
      };
    } catch (err) {
      console.error("⚠️ MetricsService.getAuditLogs error:", {
        code: typeof err?.code === 'string' ? err.code.slice(0, 40) : null,
        name: typeof err?.name === 'string' ? err.name.slice(0, 60) : 'Error',
      });
      return { logs: [], total: 0, page, limit };
    }
  }
}

module.exports = MetricsService;
module.exports.approvalAuditParams = approvalAuditParams;
module.exports.keyedDigest = keyedDigest;
module.exports.resolveAuditHmacKey = resolveAuditHmacKey;
