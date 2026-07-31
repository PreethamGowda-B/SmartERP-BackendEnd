const BasePlugin = require("./base.plugin");
const CrmSalesService = require("../../services/crmSalesService");

class CrmPlugin extends BasePlugin {
  constructor() {
    super("CrmPlugin", "Provides tools for CRM pipeline management, predictive lead scoring, and sales proposals.");

    // Tool: get_crm_pipeline_summary
    this.tools["get_crm_pipeline_summary"] = {
      name: "get_crm_pipeline_summary",
      description: "Retrieves CRM sales leads grouped by Kanban pipeline stages (New Lead, Contacted, Proposal Sent, Negotiation, Closed Won).",
      allowedRoles: ["owner", "admin", "hr", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        return await CrmSalesService.getPipelineSummary(context.user.companyId);
      },
    };
  }
}

module.exports = CrmPlugin;
