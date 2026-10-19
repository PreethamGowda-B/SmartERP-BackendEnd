const EmployeePlugin = require("./employee.plugin");
const JobsPlugin = require("./jobs.plugin");
const AttendancePlugin = require("./attendance.plugin");
const PayrollPlugin = require("./payroll.plugin");
const InventoryPlugin = require("./inventory.plugin");
const FinancialPlugin = require("./financial.plugin");
const CustomerPlugin = require("./customer.plugin");
const NavigationPlugin = require("./navigation.plugin");
const OCRPlugin = require("./ocr.plugin");
const GSTReconciliationPlugin = require("./gstReconciliation.plugin");
const LiveSummaryPlugin = require("./liveSummary.plugin");
const CncPlugin = require("./cnc.plugin");
const SecurityPlugin = require("./security.plugin");

// Enterprise-only plugin list (kept aligned with getAvailableTools and execute).
const PRO_ONLY_PLUGINS = [
  "GSTReconciliationPlugin",
  "FinancialPlugin",
];

function subscriptionAllowsTool(planTier, pluginName, toolName) {
  const tier = String(planTier || 'starter').toLowerCase();
  if (tier === 'starter') return pluginName === 'NavigationPlugin';
  if (tier === 'professional') {
    if (PRO_ONLY_PLUGINS.includes(pluginName)) return false;
    if (['forecast', 'validation', 'ar_collection'].some((key) => toolName.includes(key))) return false;
  }
  return tier === 'professional' || tier === 'enterprise';
}

class PluginRegistry {
  constructor() {
    this.plugins = [
      new LiveSummaryPlugin(),
      new EmployeePlugin(),
      new JobsPlugin(),
      new AttendancePlugin(),
      new PayrollPlugin(),
      new InventoryPlugin(),
      new FinancialPlugin(),
      new CustomerPlugin(),
      new NavigationPlugin(),
      new OCRPlugin(),
      new GSTReconciliationPlugin(),
      new CncPlugin(),
      new SecurityPlugin(),
    ];
  }

  /**
   * Aggregates tool definitions across all plugins for LLM Function Calling,
   * filtered by BOTH the user's role permissions AND subscription plan tier.
   * @param {Object} context - Authenticated user context containing user & planTier
   * @returns {Array} List of function schema objects
   */
  getAvailableTools(context) {
    const role = context?.user?.role || "employee";
    const planTier = (context?.planTier || "starter").toLowerCase();
    const availableTools = [];

    for (const plugin of this.plugins) {
      const pluginName = plugin.constructor.name;

      // 3. ROLE-BASED GATING
      for (const [toolName, tool] of Object.entries(plugin.tools || {})) {
        if (!subscriptionAllowsTool(planTier, pluginName, toolName)) continue;

        if (!tool.allowedRoles || tool.allowedRoles.includes(role)) {
          availableTools.push({
            type: "function",
            function: {
              name: toolName,
              description: tool.description,
              parameters: tool.parameters,
            },
          });
        }
      }
    }

    return availableTools;
  }

  /**
   * Finds and executes the target Tool or Skill across registered plugins.
   * Enforces server-side RBAC permission guard before executing tool code.
   * @param {string} functionName - Tool/Skill function name
   * @param {Object} params - Function arguments
   * @param {Object} context - User context
   */
  async execute(functionName, params, context) {
    const role = context?.user?.role || "employee";
    const planTier = (context?.planTier || "starter").toLowerCase();

    const targetPlugin = this.plugins.find((plugin) => plugin.tools[functionName] || plugin.skills[functionName]);
    if (!targetPlugin) {
      throw new Error(`Tool or Skill '${functionName}' is not registered in SmartERP AI Plugin Registry.`);
    }
    if (!subscriptionAllowsTool(planTier, targetPlugin.constructor.name, functionName)) {
      return {
        text: "This AI action is not available on your current plan. Ask your company owner to review available plans.",
        widget: null,
        confidenceScore: 1.0,
        sources: ["Subscription Entitlement Guard"],
      };
    }

    // 1. Hard RBAC execution guard for Payroll plugin tools
    if (functionName.startsWith("payroll_") || functionName.includes("payroll")) {
      if (role !== "owner" && role !== "hr" && role !== "super_admin") {
        return {
          text: "You don't currently have permission to access Payroll. Please contact your company administrator if you believe this is an error.",
          widget: null,
          confidenceScore: 1.0,
          sources: ["RBAC Permission Guard"],
        };
      }
    }

    // 2. Hard RBAC execution guard for Financial / GST tools
    if (functionName.startsWith("financial_") || functionName.startsWith("gst_")) {
      if (role !== "owner" && role !== "super_admin") {
        return {
          text: "You don't currently have permission to access Financials. Please contact your company administrator if you believe this is an error.",
          widget: null,
          confidenceScore: 1.0,
          sources: ["RBAC Permission Guard"],
        };
      }
    }

    for (const plugin of this.plugins) {
      if (plugin.tools[functionName] || plugin.skills[functionName]) {
        // Double check tool's allowedRoles if specified
        const tool = plugin.tools[functionName];
        if (tool && tool.allowedRoles && !tool.allowedRoles.includes(role)) {
          const moduleName = functionName.split("_")[0] || "this module";
          const capitalizedModule = moduleName.charAt(0).toUpperCase() + moduleName.slice(1);
          return {
            text: `You don't currently have permission to access ${capitalizedModule}. Please contact your company administrator if you believe this is an error.`,
            widget: null,
            confidenceScore: 1.0,
            sources: ["RBAC Permission Guard"],
          };
        }

        return await plugin.execute(functionName, params, context);
      }
    }

    throw new Error(`Tool or Skill '${functionName}' is not registered in SmartERP AI Plugin Registry.`);
  }
}

module.exports = new PluginRegistry();
