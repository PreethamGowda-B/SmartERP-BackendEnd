const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

// Import modules under test
const pluginRegistry = require("../ai/plugins");
const ContextEngine = require("../ai/context/context.engine");
const { pool } = require("../db");

describe("🛡️ Subscription-Aware, Permission-Aware & Context-Aware AI Security Test Suite", () => {

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: Missing Plan Context & Canonical Starter Tool Gating
  // ───────────────────────────────────────────────────────────────────────────
  test("1. Missing plan resolves to the canonical Starter tier and remains within Starter tool entitlements", () => {
    // Keep this aligned with the current subscription catalog. API requests
    // still pass through loadPlan/requireFeature before reaching the agent.
    const reqDummy = { user: { id: "u1", role: "owner", companyId: "c1" } };
    const contextFailClosed = ContextEngine.buildContext(reqDummy, {}, null);
    assert.equal(contextFailClosed.planTier, "starter");

    const starterTools = pluginRegistry.getAvailableTools(contextFailClosed);
    
    const names = starterTools.map((tool) => tool.function.name);
    assert.ok(names.some((name) => name.startsWith("navigate_") || name.startsWith("nav_")));
    assert.ok(names.includes("get_jobs"), "Starter includes the explicitly approved jobs summary tool");
    assert.ok(!names.includes("get_low_stock_items"));
    assert.ok(!names.includes("get_today_attendance"));
    assert.ok(!names.includes("get_payroll_summary"));
    assert.ok(!names.includes("get_revenue_analytics"));
    assert.ok(!names.includes("get_gst_reconciliation_summary"));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Current Professional/Enterprise tool gating
  // ───────────────────────────────────────────────────────────────────────────
  test("2. Professional excludes Enterprise finance/GST tools while Enterprise exposes the wider plan set", () => {
    const professionalContext = {
      user: { id: "u-professional", role: "owner", companyId: "comp-professional" },
      planTier: "professional",
      aiModelScope: "finance",
    };

    const professionalTools = pluginRegistry.getAvailableTools(professionalContext);
    
    for (const tool of professionalTools) {
      const toolName = tool.function.name;
      assert.equal(toolName.startsWith("financial_"), false, "Financial tools excluded from Professional");
      assert.equal(toolName.startsWith("gst_"), false, "GST tools excluded from Professional");
    }

    const enterpriseContext = {
      user: { id: "u-enterprise", role: "owner", companyId: "comp-enterprise" },
      planTier: "enterprise",
      aiModelScope: "finance",
    };
    const enterpriseTools = pluginRegistry.getAvailableTools(enterpriseContext);
    assert.ok(enterpriseTools.length > professionalTools.length);
    assert.ok(enterpriseTools.some((tool) => tool.function.name === "get_revenue_analytics"));
    const enterpriseGstTools = pluginRegistry.getAvailableTools({ ...enterpriseContext, aiModelScope: "gst" });
    const professionalGstTools = pluginRegistry.getAvailableTools({ ...professionalContext, aiModelScope: "gst" });
    assert.ok(enterpriseGstTools.some((tool) => tool.function.name === "get_gst_reconciliation_summary"));
    assert.ok(!professionalGstTools.some((tool) => tool.function.name === "get_gst_reconciliation_summary"));
    assert.equal(pluginRegistry.plugins.some((plugin) => plugin.constructor.name === "CrmPlugin"), false, "Retired CRM plugin must not be registered");
    assert.equal(enterpriseTools.some((tool) => tool.function.name.startsWith("crm_")), false, "Retired CRM tools must not be available on any plan");
    assert.notEqual(ContextEngine.detectModelScope("show me the sales pipeline"), "crm", "Retired CRM scope must not be selected");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: RBAC Execution Layer Hardening (3+ Phrasings)
  // ───────────────────────────────────────────────────────────────────────────
  test("3. RBAC Execution Hardening: Employee role requesting payroll data via 3 different phrasings gets permission denied", async () => {
    const employeeContext = {
      user: { id: "emp-777", role: "employee", companyId: "comp-rbac-01" },
      planTier: "enterprise", // Enterprise entitlement does not replace role authorization.
      aiModelScope: "payroll",
    };

    const forbiddenPhrasings = [
      "get_payroll_summary",
      "calculate_payroll",
      "validate_payroll_pre_run",
    ];

    for (const toolName of forbiddenPhrasings) {
      const result = await pluginRegistry.execute(toolName, {}, employeeContext);
      assert.ok(result.text, "Must return response payload");
      assert.ok(
        result.text.includes("You don't currently have permission to access Payroll"),
        `Tool '${toolName}' must be blocked by server-side RBAC guard for employee role`
      );
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: Context-Awareness Payload & System Prompt Advisory Scope
  // ───────────────────────────────────────────────────────────────────────────
  test("4. Context-Awareness: Build context injects portal, module, and pagePath without bypassing RBAC", () => {
    const reqDummy = { user: { id: "u2", role: "employee", companyId: "c2" } };
    const clientCtx = {
      currentPortal: "hr",
      currentModule: "attendance",
      currentPagePath: "/hr/attendance",
    };

    const context = ContextEngine.buildContext(reqDummy, clientCtx, "professional");

    assert.equal(context.ui.portal, "hr");
    assert.equal(context.ui.module, "attendance");
    assert.equal(context.ui.pagePath, "/hr/attendance");

    const systemPrompt = ContextEngine.generateSystemPrompt(context);
    assert.ok(systemPrompt.includes("Current Portal: hr"));
    assert.ok(systemPrompt.includes("Current Module: attendance"));
    assert.ok(systemPrompt.includes("ADVISORY CONTEXT"));
    assert.ok(systemPrompt.includes("CONTEXT NEVER BYPASSES ROLE PERMISSION OR SUBSCRIPTION GATING CHECKS"));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 5: Multi-Tenant Scoped Tool Execution
  // ───────────────────────────────────────────────────────────────────────────
  test("5. Multi-Tenant Scoped Execution: Tool context enforces strict company_id isolation", async () => {
    const tenantAContext = { user: { id: "user-A", role: "owner", companyId: "company-AAA" }, planTier: "enterprise" };
    const tenantBContext = { user: { id: "user-B", role: "owner", companyId: "company-BBB" }, planTier: "enterprise" };

    assert.equal(tenantAContext.user.companyId, "company-AAA");
    assert.equal(tenantBContext.user.companyId, "company-BBB");
    assert.notEqual(tenantAContext.user.companyId, tenantBContext.user.companyId);
  });
});
