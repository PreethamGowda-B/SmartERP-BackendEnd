const BasePlugin = require("./base.plugin");
const FinancialService = require("../../services/financialService");

class FinancialPlugin extends BasePlugin {
  constructor() {
    super("FinancialPlugin", "Financials");

    // Tool: get_revenue_analytics
    this.tools["get_revenue_analytics"] = {
      name: "get_revenue_analytics",
      description: "Retrieves monthly revenue, invoice totals, and payment metrics for the company.",
      allowedRoles: ["owner", "admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        return await FinancialService.getRevenueAnalytics({
          companyId: context.user.companyId,
        });
      },
    };

    // Tool: get_unpaid_invoices
    this.tools["get_unpaid_invoices"] = {
      name: "get_unpaid_invoices",
      description: "Identifies pending or unpaid client invoices.",
      allowedRoles: ["owner", "admin", "hr"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        return await FinancialService.getUnpaidInvoices({
          companyId: context.user.companyId,
        });
      },
    };
  }
}

module.exports = FinancialPlugin;
