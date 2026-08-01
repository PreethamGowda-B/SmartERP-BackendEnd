const { pool } = require("../../db");

class MetricsService {
  /**
   * Ensures the ai_audit_logs table exists.
   */
  static async ensureTable() {
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
  }

  /**
   * Writes AI action execution audit record to PostgreSQL table.
   */
  static async logAIAuditEvent({ userContext, toolName, params, status = "SUCCESS", error = null }) {
    try {
      const companyId = userContext?.user?.companyId || "0";
      const userId = userContext?.user?.id || "0";
      const role = userContext?.user?.role || "user";

      await this.ensureTable();

      await pool.query(
        `INSERT INTO ai_audit_logs (company_id, user_id, user_role, tool_name, action_params, status, error_message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [String(companyId), String(userId), role, toolName, JSON.stringify(params || {}), status, error ? String(error) : null]
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
        `INSERT INTO ai_audit_logs (company_id, user_id, user_role, tool_name, action_params, status, error_message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          String(companyId),
          String(userId),
          role,
          "PRO_PLAN_INTERCEPTION",
          JSON.stringify({ prompt, matchedKeyword, planTier }),
          "INTERCEPTED",
          `Rule match: '${matchedKeyword}' on '${planTier}' plan`
        ]
      );
    } catch (err) {
      console.warn("⚠️ MetricsService logAIInterception warning:", err.message);
    }
  }
}

module.exports = MetricsService;
