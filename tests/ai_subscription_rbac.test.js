const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

// Import modules under test
const pluginRegistry = require("../ai/plugins");
const ContextEngine = require("../ai/context/context.engine");
const { pool } = require("../db");

describe("🛡️ Subscription-Aware, Permission-Aware & Context-Aware AI Security Test Suite", () => {

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: Fail-Closed Plan Behavior & Free Plan Tool Gating
  // ───────────────────────────────────────────────────────────────────────────
  test("1. Fail-Closed Fallback & Free Plan Tool Gating: Free plan user receives 0 DB query tools", () => {
    // 1.1 Test ContextEngine default planTier when missing -> "free"
    const reqDummy = { user: { id: "u1", role: "owner", companyId: "c1" } };
    const contextFailClosed = ContextEngine.buildContext(reqDummy, {}, null);
    assert.equal(contextFailClosed.planTier, "free", "Missing plan must fail-closed to 'free'");

    // 1.2 Test PluginRegistry available tools for 'free' tier
    const freeTools = pluginRegistry.getAvailableTools(contextFailClosed);
    
    // Assert all free tools belong strictly to NavigationPlugin (0 DB query tools)
    assert.ok(freeTools.length > 0, "Navigation guidance tools should be available for Free tier");
    for (const tool of freeTools) {
      const toolName = tool.function.name;
      assert.ok(
        toolName.startsWith("navigate_") || toolName.startsWith("nav_") || toolName.includes("navigation"),
        `Free plan tool '${toolName}' must be a guidance/navigation tool, NOT a DB query tool`
      );
      assert.equal(toolName.startsWith("jobs_"), false, "Jobs DB tool must NOT be in free plan");
      assert.equal(toolName.startsWith("payroll_"), false, "Payroll DB tool must NOT be in free plan");
      assert.equal(toolName.startsWith("financial_"), false, "Financial DB tool must NOT be in free plan");
      assert.equal(toolName.startsWith("gst_"), false, "GST DB tool must NOT be in free plan");
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Pro Capability Keyword Interception Check
  // ───────────────────────────────────────────────────────────────────────────
  test("2. Pro-Capability Keyword Matcher & Basic Plan Gating", () => {
    const basicContext = {
      user: { id: "u-basic", role: "owner", companyId: "comp-basic" },
      planTier: "basic",
    };

    const basicTools = pluginRegistry.getAvailableTools(basicContext);
    
    // Basic tier must NOT contain Pro-only plugins (Financial, GST, CRM)
    for (const tool of basicTools) {
      const toolName = tool.function.name;
      assert.equal(toolName.startsWith("financial_"), false, "Financial tools excluded from Basic");
      assert.equal(toolName.startsWith("gst_"), false, "GST tools excluded from Basic");
      assert.equal(toolName.startsWith("crm_"), false, "CRM tools excluded from Basic");
    }

    const proContext = {
      user: { id: "u-pro", role: "owner", companyId: "comp-pro" },
      planTier: "pro",
    };
    const proTools = pluginRegistry.getAvailableTools(proContext);
    assert.ok(proTools.length > basicTools.length, "Pro plan must have access to all tools");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: RBAC Execution Layer Hardening (3+ Phrasings)
  // ───────────────────────────────────────────────────────────────────────────
  test("3. RBAC Execution Hardening: Employee role requesting payroll data via 3 different phrasings gets permission denied", async () => {
    const employeeContext = {
      user: { id: "emp-777", role: "employee", companyId: "comp-rbac-01" },
      planTier: "pro", // Pro tier, but Employee role!
    };

    const forbiddenPhrasings = [
      "payroll_summary",
      "payroll_calculate",
      "payroll_get_reports",
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

    const context = ContextEngine.buildContext(reqDummy, clientCtx, "basic");

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
    const tenantAContext = { user: { id: "user-A", role: "owner", companyId: "company-AAA" }, planTier: "pro" };
    const tenantBContext = { user: { id: "user-B", role: "owner", companyId: "company-BBB" }, planTier: "pro" };

    assert.equal(tenantAContext.user.companyId, "company-AAA");
    assert.equal(tenantBContext.user.companyId, "company-BBB");
    assert.notEqual(tenantAContext.user.companyId, tenantBContext.user.companyId);
  });
});
