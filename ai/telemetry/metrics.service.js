const { pool } = require("../../db");

class MetricsService {
  /**
   * Ensures the ai_audit_logs table exists with all extended columns.
   */
  static async ensureTable() {
    // Create base table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_role VARCHAR(50) NOT NULL,
        tool_name VARCHAR(100) NOT NULL,
        action_params JSONB NOT NULL,
        status VARCHAR(40) NOT NULL,
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Additive column extensions — safe to run multiple times
    const extensions = [
      "ALTER TABLE ai_audit_logs ADD COLUMN IF NOT EXISTS portal VARCHAR(50)",
      "ALTER TABLE ai_audit_logs ADD COLUMN IF NOT EXISTS module VARCHAR(100)",
      "ALTER TABLE ai_audit_logs ADD COLUMN IF NOT EXISTS plan_tier VARCHAR(20)",
      "ALTER TABLE ai_audit_logs ADD COLUMN IF NOT EXISTS model_scope VARCHAR(50)",
      "ALTER TABLE ai_audit_logs ADD COLUMN IF NOT EXISTS latency_ms INTEGER",
      "ALTER TABLE ai_audit_logs ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(5,4)",
      "ALTER TABLE ai_audit_logs ADD COLUMN IF NOT EXISTS blocked BOOLEAN DEFAULT FALSE",
      "ALTER TABLE ai_audit_logs ADD COLUMN IF NOT EXISTS prompt_preview TEXT",
    ];

    for (const sql of extensions) {
      await pool.query(sql).catch(() => {}); // Ignore if column already exists
    }
  }

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
  }) {
    try {
      const companyId = userContext?.user?.companyId || "0";
      const userId = userContext?.user?.id || "0";
      const role = userContext?.user?.role || "user";
      const resolvedPortal = portal || userContext?.ui?.portal || null;
      const resolvedModule = module || userContext?.ui?.module || null;

      await this.ensureTable();

      await pool.query(
        `INSERT INTO ai_audit_logs (
          company_id, user_id, user_role, tool_name, action_params, status, error_message,
          portal, module, plan_tier, model_scope, latency_ms, confidence_score, blocked, prompt_preview,
          created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
        [
          String(companyId),
          String(userId),
          role,
          toolName,
          JSON.stringify(params || {}),
          status,
          error ? String(error) : null,
          resolvedPortal,
          resolvedModule,
          planTier,
          modelScope,
          latencyMs,
          confidenceScore,
          blocked,
          promptPreview ? promptPreview.substring(0, 200) : null,
        ]
      );
    } catch (err) {
      console.warn("⚠️ MetricsService audit logging warning:", err.message);
    }
  }

  /**
   * Logs Pro-capability rule-based interceptions for audit and tuning.
   */
  static async logAIInterception({ userContext, prompt, matchedKeyword, planTier }) {
    try {
      const companyId = userContext?.user?.companyId || "0";
      const userId = userContext?.user?.id || "0";
      const role = userContext?.user?.role || "user";

      await this.ensureTable();

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
          JSON.stringify({ prompt, matchedKeyword, planTier }),
          "INTERCEPTED",
          `Rule match: '${matchedKeyword}' on '${planTier}' plan`,
          planTier,
          true,
          prompt ? prompt.substring(0, 200) : null,
        ]
      );
    } catch (err) {
      console.warn("⚠️ MetricsService logAIInterception warning:", err.message);
    }
  }

  /**
   * Returns aggregated AI usage statistics for the Super Admin AI Operations dashboard.
   * @returns {Promise<Object>} stats
   */
  static async getAIStats() {
    try {
      await this.ensureTable();

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
      console.error("⚠️ MetricsService.getAIStats error:", err.message);
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
      await this.ensureTable();
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
          `SELECT * FROM ai_audit_logs ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
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
      console.error("⚠️ MetricsService.getAuditLogs error:", err.message);
      return { logs: [], total: 0, page, limit };
    }
  }
}

module.exports = MetricsService;
