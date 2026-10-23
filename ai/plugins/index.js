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
const { isPluginAllowedForAiScope } = require("../../services/aiPluginScope");
const { TOOL_SCOPES_BY_PLUGIN, hasAiToolEntitlement } = require("../../services/aiToolEntitlements");
const { FAST_PATH_POLICIES } = require("../../services/aiFastPathPolicy");
const { validateToolArguments } = require('./toolArguments');

// Enterprise-only plugin list (kept aligned with getAvailableTools and execute).
const PRO_ONLY_PLUGINS = [
  "GSTReconciliationPlugin",
  "FinancialPlugin",
];

function subscriptionAllowsTool(planTier, pluginName, toolName, modelScope) {
  const tier = String(planTier || '').toLowerCase();
  if (!['starter', 'professional', 'enterprise'].includes(tier)) return false;
  if (!hasAiToolEntitlement(tier, pluginName, toolName, modelScope)) return false;
  if (tier === 'starter') {
    return pluginName === 'NavigationPlugin'
      || (pluginName === 'JobsPlugin' && ['get_jobs', 'get_delayed_jobs'].includes(toolName));
  }
  if (tier === 'professional') {
    if (PRO_ONLY_PLUGINS.includes(pluginName)) return false;
    if (['forecast', 'validation', 'ar_collection'].some((key) => toolName.includes(key))) return false;
  }
  return tier === 'professional' || tier === 'enterprise';
}

function roleAllowedByExecutionGuard(role, pluginName, functionName) {
  if (pluginName === 'PayrollPlugin') {
    // Payroll read/write API routes consistently authorize company-wide
    // payroll access to owners and admins. HR has HR summary routes, but not
    // company-wide payroll records through the API.
    return FAST_PATH_POLICIES.payroll.roles.includes(role);
  }
  if (pluginName === 'FinancialPlugin') {
    return FAST_PATH_POLICIES.finance.roles.includes(role);
  }
  if (pluginName === 'GSTReconciliationPlugin') {
    return FAST_PATH_POLICIES.gst.roles.includes(role);
  }
  if (functionName.startsWith("payroll_") || functionName.includes("payroll")) {
    return ["owner", "admin"].includes(role);
  }
  if (functionName.startsWith("financial_") || functionName.startsWith("gst_")) {
    return ["owner", "admin"].includes(role);
  }
  return true;
}

function hasProtectedToolIdentityContext(pluginName, context) {
  if (!Object.hasOwn(TOOL_SCOPES_BY_PLUGIN, pluginName)) return true;
  const user = context?.user;
  return Boolean(
    (user?.id || user?.userId)
    && (user?.companyId || user?.company_id)
  );
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
    const role = String(context?.user?.role || "employee").toLowerCase();
    const planTier = String(context?.planTier || "").toLowerCase();
    const availableTools = [];

    for (const plugin of this.plugins) {
      const pluginName = plugin.constructor.name;
      if (!hasProtectedToolIdentityContext(pluginName, context)) continue;
      if (!isPluginAllowedForAiScope(context?.aiModelScope, pluginName)) continue;

      // 3. ROLE-BASED GATING
      for (const [toolName, tool] of Object.entries(plugin.tools || {})) {
        if (!subscriptionAllowsTool(planTier, pluginName, toolName, context?.aiModelScope)) continue;

        if (roleAllowedByExecutionGuard(role, pluginName, toolName) && (!tool.allowedRoles || tool.allowedRoles.includes(role))) {
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
    const role = String(context?.user?.role || "employee").toLowerCase();
    const planTier = String(context?.planTier || "").toLowerCase();

    const targetPlugin = this.plugins.find((plugin) => plugin.tools[functionName] || plugin.skills[functionName]);
    if (!targetPlugin) {
      throw new Error(`Tool or Skill '${functionName}' is not registered in SmartERP AI Plugin Registry.`);
    }
    if (!hasProtectedToolIdentityContext(targetPlugin.constructor.name, context)) {
      const error = new Error('Authenticated company access context is required for this AI tool.');
      error.code = 'AI_AUTH_CONTEXT_UNAVAILABLE';
      throw error;
    }
    if (!subscriptionAllowsTool(planTier, targetPlugin.constructor.name, functionName, context?.aiModelScope)) {
      const error = new Error('The requested AI tool is not included in the verified plan.');
      error.code = 'AI_TOOL_ENTITLEMENT_DENIED';
      throw error;
    }
    if (!isPluginAllowedForAiScope(context?.aiModelScope, targetPlugin.constructor.name)) {
      const error = new Error('The selected AI specialist is not authorized for this tool.');
      error.code = 'AI_TOOL_SCOPE_DENIED';
      throw error;
    }
    // Enforce the same explicit role policy used by deterministic fast paths.
    if (!roleAllowedByExecutionGuard(role, targetPlugin.constructor.name, functionName)) {
      if (functionName.startsWith("payroll_") || functionName.includes("payroll")) {
        return {
          text: "You don't currently have permission to access Payroll. Please contact your company administrator if you believe this is an error.",
          widget: null,
          confidenceScore: 1.0,
          sources: ["RBAC Permission Guard"],
        };
      } else {
        return {
          text: "You don't currently have permission to access Financials. Please contact your company administrator if you believe this is an error.",
          widget: null,
          confidenceScore: 1.0,
          sources: ["RBAC Permission Guard"],
        };
      }
    }

    const registeredTool = targetPlugin.tools[functionName];
    params = validateToolArguments(params, registeredTool?.parameters || { type: 'object' });

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
