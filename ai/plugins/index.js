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
const CrmPlugin = require("./crm.plugin");
const LiveSummaryPlugin = require("./liveSummary.plugin");
const CncPlugin = require("./cnc.plugin");

// Pro-only plugin list
const PRO_ONLY_PLUGINS = [
  "GSTReconciliationPlugin",
  "FinancialPlugin",
  "CrmPlugin",
];

// Basic-allowed plugin list
const BASIC_ALLOWED_PLUGINS = [
  "NavigationPlugin",
  "LiveSummaryPlugin",
  "EmployeePlugin",
  "JobsPlugin",
  "AttendancePlugin",
  "InventoryPlugin",
  "CustomerPlugin",
  "OCRPlugin",
  "CncPlugin",
];

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
      new CrmPlugin(),
      new CncPlugin(),
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
    const planTier = (context?.planTier || "free").toLowerCase();
    const availableTools = [];

    for (const plugin of this.plugins) {
      const pluginName = plugin.constructor.name;

      // 1. FREE PLAN GATING: Only Navigation / Guidance tools (0 DB query tools)
      if (planTier === "free") {
        if (pluginName !== "NavigationPlugin") {
          continue;
        }
      }

      // 2. BASIC PLAN GATING: Exclude Pro-only plugins
      if (planTier === "basic") {
        if (PRO_ONLY_PLUGINS.includes(pluginName)) {
          continue;
        }
      }

      // 3. ROLE-BASED GATING
      for (const [toolName, tool] of Object.entries(plugin.tools || {})) {
        // Exclude specific Pro tools for Basic tier (e.g. forecasting, payroll validation)
        if (planTier === "basic") {
          if (toolName.includes("forecast") || toolName.includes("validation") || toolName.includes("ar_collection")) {
            continue;
          }
        }

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

    // 2. Hard RBAC execution guard for Financial / GST / CRM tools
    if (functionName.startsWith("financial_") || functionName.startsWith("gst_") || functionName.startsWith("crm_")) {
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
