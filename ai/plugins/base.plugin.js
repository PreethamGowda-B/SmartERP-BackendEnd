/**
 * Base Abstract Class for SmartERP AI Plugins.
 * Every module registers as a self-contained Plugin defining Tools (data accessors)
 * and Skills (domain intelligence & multi-step calculations).
 */
const { createApprovalToken, stableHash } = require('../../services/aiActionApproval');

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

    // Client/model-supplied `confirmed` is never an approval. A write is
    // executable only when the confirmation route has verified a signed,
    // single-use approval for this exact tool and payload.
    const safeParams = params && typeof params === 'object' && !Array.isArray(params)
      ? { ...params }
      : {};
    delete safeParams.confirmed;
    const approved = context?.approvedAiAction?.toolName === functionName
      && context.approvedAiAction.payloadHash === stableHash(safeParams);
    if (target.isDestructive && !approved) {
      let approvalToken;
      try {
        approvalToken = createApprovalToken({
          userId: context?.user?.id || context?.user?.userId,
          companyId: context?.user?.companyId || context?.user?.company_id,
          action: `plugin_tool:${functionName}`,
          payload: safeParams,
        });
      } catch (error) {
        return { error: error.code || 'AI_APPROVAL_NOT_CONFIGURED', message: 'A secure approval could not be created. No changes were made.' };
      }
      return {
        type: "ACTION_CONFIRMATION_REQUIRED",
        toolName: functionName,
        plugin: this.name,
        params: safeParams,
        approval_token: approvalToken,
        approval_expires_in_seconds: 300,
        message: `Are you sure you want to execute action: "${target.description}"?`,
      };
    }

    return await target.execute(safeParams, context);
  }
}

module.exports = BasePlugin;
