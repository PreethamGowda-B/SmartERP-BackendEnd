/**
 * SmartERP Context Engine
 * Captures user identity, tenant isolation scope, current UI route,
 * portal/module/page context, and systemic role permissions for AI planning.
 * Supports model-scope-aware system prompt personas for specialist AI modes.
 */

// Model scope → persona system prompt prefix map
const MODEL_SCOPE_PERSONAS = {
  finance: `You are the SmartERP Finance AI — a highly specialized financial intelligence agent.
You are an expert in revenue analysis, expense tracking, profit & loss, cash flow, invoicing, billing, and financial reporting.
Always ground financial figures in actual tool data. Never invent numbers.`,

  payroll: `You are the SmartERP Payroll AI — a highly specialized payroll and compensation intelligence agent.
You are an expert in salary computation, pay slip generation, overtime calculations, payroll periods, deductions, and compliance.
Always retrieve actual payroll data through tools before responding.`,

  inventory: `You are the SmartERP Inventory Expert — a highly specialized inventory and supply chain intelligence agent.
You are an expert in stock levels, warehouse management, reorder points, supplier management, purchase orders, and inventory forecasting.
Always retrieve live inventory data through tools before responding.`,

  attendance: `You are the SmartERP Attendance AI — a highly specialized workforce attendance intelligence agent.
You are an expert in clock-in/clock-out tracking, daily attendance summaries, leave management, absenteeism analysis, and shift scheduling.
Always retrieve actual attendance records through tools before responding.`,

  hr: `You are the SmartERP HR Assistant — a highly specialized human resources intelligence agent.
You are an expert in employee lifecycle management, onboarding, performance appraisals, leave requests, disciplinary processes, and HR compliance.
Always retrieve actual employee data through tools before responding.`,

  gst: `You are the SmartERP GST Intelligence — a highly specialized taxation and compliance intelligence agent.
You are an expert in GST reconciliation, GSTR filing, HSN codes, IGST/CGST/SGST classification, vendor compliance, and tax reporting.
Always retrieve actual GST and financial data through tools before responding.`,

  executive: `You are the SmartERP Executive AI — a highly specialized strategic business intelligence agent.
You are an expert in cross-module analytics, company performance analysis, revenue forecasting, business insights, and executive reporting.
You synthesize data across departments to give the business owner a complete operational picture.
Always retrieve actual data across modules through tools before responding.`,

  crm: `You are the SmartERP CRM AI — a highly specialized customer relationship and sales intelligence agent.
You are an expert in lead management, sales pipeline tracking, customer analytics, deal conversion, and CRM strategy.
Always retrieve actual CRM and customer data through tools before responding.`,

  general: `You are the SmartERP Enterprise AI Agent — the intelligent operating system layer of SmartERP.
You act like an experienced ERP Consultant and Business Analyst who can answer questions across all modules.`,
};

// Follow-up suggestion map keyed by model scope
const FOLLOW_UP_SUGGESTIONS = {
  finance: ["Show this month's revenue", "Cash flow summary", "Outstanding invoices", "Expense breakdown", "Profit & Loss report"],
  payroll: ["Generate payroll for this period", "Show pending payslips", "Overtime report", "Deduction summary", "Payroll trends"],
  inventory: ["Low stock alerts", "Inventory forecast", "Top moving items", "Supplier report", "Purchase order status"],
  attendance: ["Today's attendance", "Late arrivals this week", "Leave requests pending", "Monthly attendance chart", "Absenteeism report"],
  hr: ["Employee list", "New joiners this month", "Pending appraisals", "Leave balance report", "Department headcount"],
  gst: ["GST reconciliation report", "Vendor compliance status", "GSTR summary", "Tax filing due dates", "Input tax credit"],
  executive: ["Company performance summary", "Revenue forecast", "Department comparison", "KPI dashboard", "Growth trends"],
  crm: ["Sales pipeline status", "Lead conversion rate", "Customer analytics", "Top customers", "Deal forecast"],
  general: ["Attendance overview", "Payroll summary", "Inventory status", "GST report", "Executive report"],
};

class ContextEngine {
  /**
   * Constructs the structured Context Object for AI Planning.
   * @param {Object} req - Express Request
   * @param {Object} [clientContext] - Frontend UI context payload
   * @param {string} [planTier] - Resolved subscription tier ("free" | "basic" | "pro")
   * @returns {Object} System context & instructions
   */
  static buildContext(req, clientContext = {}, planTier = "free") {
    const user = req?.user || {};
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
      planTier: planTier || "free",
      ui: {
        portal: clientContext.currentPortal || clientContext.portal || "owner",
        module: clientContext.currentModule || clientContext.module || null,
        pagePath: clientContext.currentPagePath || clientContext.pagePath || clientContext.currentPage || "/",
        currentPage: clientContext.currentPagePath || clientContext.pagePath || clientContext.currentPage || "/",
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
   * Generates model-scope-aware System Prompt with Context Injection & Security Rules.
   * @param {Object} context - Built context from buildContext
   * @param {string} [modelScope] - Specialist model scope ("finance"|"payroll"|"inventory"|etc.)
   * @returns {string} Fully injected System Prompt
   */
  static generateSystemPrompt(context, modelScope = "general") {
    const scope = modelScope && MODEL_SCOPE_PERSONAS[modelScope] ? modelScope : "general";
    const persona = MODEL_SCOPE_PERSONAS[scope];

    return `
${persona}

==========================================================
BRANDED IDENTITY
==========================================================
You are operating as **SmartERP Intelligence** — the enterprise AI layer of SmartERP.
Never refer to yourself as "ChatGPT", "an AI", or "a language model". Always say "SmartERP Intelligence" or "I" in context.

==========================================================
AUTHENTICATED USER CONTEXT (TENANT ISOLATED)
==========================================================
- User Name: ${context.user.name}
- Email: ${context.user.email}
- Role: ${context.user.role} (STRICTLY RESTRICT OPERATIONS TO PERMISSIONS OF THIS ROLE)
- Plan Tier: ${context.planTier}
- Company ID: ${context.user.companyId}
- Current Local Time: ${context.system.currentTimestamp} (${context.system.timezone})
- Current Portal: ${context.ui.portal}
- Current Module: ${context.ui.module || 'General'}
- Current Page Path: ${context.ui.pagePath}

==========================================================
OPERATIONAL MANDATES & INTEGRITY RULES
==========================================================
1. NEVER GUESS OR FABRICATE ERP DATA. All numbers, job counts, attendance figures, payroll amounts, and inventory stats MUST come from tools.
2. TENANT ISOLATION: Every operation is strictly scoped to Company ID '${context.user.companyId}'. You must NEVER reveal or query data belonging to other companies.
3. ADVISORY CONTEXT: Use Current Portal, Module, and Page Path as advisory context to interpret ambiguous user queries. CONTEXT NEVER BYPASSES ROLE PERMISSION OR SUBSCRIPTION GATING CHECKS.
4. ROLE PERMISSION GUARD:
   - 'owner': Full access to financials, payroll, analytics, all employees, jobs, inventory, settings.
   - 'hr': Employee management, attendance, payroll calculations, leave requests.
   - 'employee': Personal attendance, assigned jobs, personal messages, leave requests.
   - 'super_admin': Platform metrics, company management.
   If a user asks for data above their role permissions, politely inform them that their role does not have authorization.

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

  /**
   * Returns suggested follow-up prompts based on the model scope used.
   * @param {string} modelScope
   * @returns {string[]}
   */
  static getSuggestedFollowUps(modelScope = "general") {
    const scope = modelScope && FOLLOW_UP_SUGGESTIONS[modelScope] ? modelScope : "general";
    const all = FOLLOW_UP_SUGGESTIONS[scope];
    // Return top 4 suggestions
    return all.slice(0, 4);
  }

  /**
   * Auto-detects the best model scope from the user prompt using keyword routing.
   * @param {string} prompt
   * @returns {string} model scope key
   */
  static detectModelScope(prompt) {
    if (!prompt) return "general";
    const lower = prompt.toLowerCase();

    const SCOPE_KEYWORDS = {
      gst: ["gst", "tax reconciliation", "gstr", "hsn", "igst", "cgst", "sgst", "input tax credit", "tax filing"],
      payroll: ["payroll", "salary", "pay slip", "payslip", "wages", "overtime pay", "deduction", "pay period"],
      finance: ["revenue", "cash flow", "profit", "expense", "invoice", "billing", "financial", "balance sheet", "p&l", "income"],
      inventory: ["inventory", "stock", "warehouse", "reorder", "low stock", "supplier", "purchase order", "material", "sku"],
      attendance: ["attendance", "clock in", "check in", "present", "absent", "leave", "shift", "working hours", "late"],
      hr: ["employee", "hire", "onboard", "performance", "appraisal", "resignation", "department", "headcount", "recruit"],
      executive: ["forecast", "analyze company", "executive report", "business analysis", "kpi", "company performance", "growth", "strategic", "predictive"],
      crm: ["crm", "lead", "sales pipeline", "deal", "prospect", "customer relationship", "conversion", "sales stage"],
    };

    for (const [scope, keywords] of Object.entries(SCOPE_KEYWORDS)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        return scope;
      }
    }
    return "general";
  }
}

module.exports = ContextEngine;
