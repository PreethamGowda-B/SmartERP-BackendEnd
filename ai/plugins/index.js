const EmployeePlugin = require("./employee.plugin");
const JobsPlugin = require("./jobs.plugin");
const AttendancePlugin = require("./attendance.plugin");
const PayrollPlugin = require("./payroll.plugin");
const InventoryPlugin = require("./inventory.plugin");
const FinancialPlugin = require("./financial.plugin");
const CustomerPlugin = require("./customer.plugin");
const NavigationPlugin = require("./navigation.plugin");
const OCRPlugin = require("./ocr.plugin");

class PluginRegistry {
  constructor() {
    this.plugins = [
      new EmployeePlugin(),
      new JobsPlugin(),
      new AttendancePlugin(),
      new PayrollPlugin(),
      new InventoryPlugin(),
      new FinancialPlugin(),
      new CustomerPlugin(),
      new NavigationPlugin(),
      new OCRPlugin(),
    ];
  }

  /**
   * Aggregates tool definitions across all plugins for LLM Function Calling,
   * filtered by the user's role permissions.
   * @param {Object} context - Authenticated user context
   * @returns {Array} List of function schema objects
   */
  getAvailableTools(context) {
    const role = context.user.role || "employee";
    const availableTools = [];

    for (const plugin of this.plugins) {
      for (const [toolName, tool] of Object.entries(plugin.tools)) {
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
   * @param {string} functionName - Tool/Skill function name
   * @param {Object} params - Function arguments
   * @param {Object} context - User context
   */
  async execute(functionName, params, context) {
    for (const plugin of this.plugins) {
      if (plugin.tools[functionName] || plugin.skills[functionName]) {
        return await plugin.execute(functionName, params, context);
      }
    }

    throw new Error(`Tool or Skill '${functionName}' is not registered in SmartERP AI Plugin Registry.`);
  }
}

module.exports = new PluginRegistry();
