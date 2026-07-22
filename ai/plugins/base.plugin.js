/**
 * Base Abstract Class for SmartERP AI Plugins.
 * Every module registers as a self-contained Plugin defining Tools (data accessors)
 * and Skills (domain intelligence & multi-step calculations).
 */
class BasePlugin {
  /**
   * @param {string} name - Plugin Name
   * @param {string} module - Corresponding ERP Module name
   */
  constructor(name, module) {
    this.name = name;
    this.module = module;
    this.tools = [];
    this.skills = [];
  }

  /**
   * Returns registered tool definitions formatted for LLM Function Calling.
   */
  getToolSchemas() {
    return Object.values(this.tools).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Executes a registered Tool or Skill with Tenant & Role Security Validation.
   * @param {string} functionName - Name of tool or skill to execute
   * @param {Object} params - Arguments provided by LLM
   * @param {Object} context - Authenticated user context
   */
  async execute(functionName, params, context) {
    const target = this.tools[functionName] || this.skills[functionName];

    if (!target) {
      throw new Error(`Function '${functionName}' not found in plugin '${this.name}'`);
    }

    // Role Permission Validation
    if (target.allowedRoles && !target.allowedRoles.includes(context.user.role)) {
      return {
        error: "PERMISSION_DENIED",
        message: `Your current role ('${context.user.role}') is not authorized to execute '${functionName}'.`,
      };
    }

    // Check if destructive action requires confirmation
    if (target.isDestructive && !params.confirmed) {
      return {
        type: "ACTION_CONFIRMATION_REQUIRED",
        toolName: functionName,
        plugin: this.name,
        params,
        message: `Are you sure you want to execute action: "${target.description}"?`,
      };
    }

    return await target.execute(params, context);
  }
}

module.exports = BasePlugin;
