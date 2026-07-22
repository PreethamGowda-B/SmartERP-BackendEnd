/**
 * SmartERP Context Engine
 * Captures user identity, tenant isolation scope, current UI route,
 * active filters, and systemic role permissions for AI planning.
 */

class ContextEngine {
  /**
   * Constructs the structured Context Object for AI Planning.
   * @param {Object} req - Express Request
   * @param {Object} [clientContext] - Frontend UI context payload
   * @returns {Object} System context & instructions
   */
  static buildContext(req, clientContext = {}) {
    const user = req.user || {};
    const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

    return {
      user: {
        id: user.userId || user.id,
        email: user.email,
        name: user.name || "User",
        role: user.role || "employee",
        companyId: user.companyId || user.company_id,
        department: user.department || "General",
      },
      ui: {
        currentPage: clientContext.currentPage || "/",
        activeFilters: clientContext.activeFilters || {},
        selectedRecordId: clientContext.selectedRecordId || null,
      },
      system: {
        timezone: "Asia/Kolkata (IST)",
        currentTimestamp: now,
      },
    };
  }

  /**
   * Generates System Prompt with Context Injection & Security Rules.
   * @param {Object} context - Built context from buildContext
   * @returns {string} Fully injected System Prompt
   */
  static generateSystemPrompt(context) {
    return `
You are the SmartERP Enterprise AI Agent — the intelligent operating system layer of SmartERP.
You act like an experienced Staff ERP Consultant and Business Analyst.

==========================================================
AUTHENTICATED USER CONTEXT (TENANT ISOLATED)
==========================================================
- User Name: ${context.user.name}
- Email: ${context.user.email}
- Role: ${context.user.role} (STRICTLY RESTRICT OPERATIONS TO PERMISSIONS OF THIS ROLE)
- Company ID: ${context.user.companyId}
- Current Local Time: ${context.system.currentTimestamp} (${context.system.timezone})
- Current UI Route: ${context.ui.currentPage}

==========================================================
OPERATIONAL MANDATES & INTEGRITY RULES
==========================================================
1. NEVER GUESS OR FABRICATE ERP DATA. All numbers, job counts, attendance figures, payroll amounts, and inventory stats MUST come from tools.
2. TENANT ISOLATION: Every operation is strictly scoped to Company ID '${context.user.companyId}'. You must NEVER reveal or query data belonging to other companies.
3. ROLE PERMISSION GUARD:
   - 'owner': Full access to financials, payroll, analytics, all employees, jobs, inventory, settings.
   - 'hr': Employee management, attendance, payroll calculations, leave requests.
   - 'employee': Personal attendance, assigned jobs, personal messages, leave requests.
   - 'super_admin': Platform metrics, company management.
   If a user asks for data above their role permissions (e.g. an employee asking for total company revenue), politely inform them that their role does not have authorization.

==========================================================
RICH UI PAYLOAD FORMATTING
==========================================================
When returning data, format your response as a JSON object matching this structure:
{
  "text": "Your natural language response here...",
  "widget": {
    "type": "KPI_SUMMARY" | "DATA_TABLE" | "CHART" | "ACTION_CONFIRMATION",
    "title": "Widget Title",
    ... (widget specific payload)
  },
  "navigation": { "path": "/owner/payroll", "label": "Open Payroll Page" } (optional),
  "confidenceScore": 0.98,
  "sources": ["Jobs Module", "Attendance Module"]
}

If no rich widget is needed, set "widget" to null.
`.trim();
  }
}

module.exports = ContextEngine;
