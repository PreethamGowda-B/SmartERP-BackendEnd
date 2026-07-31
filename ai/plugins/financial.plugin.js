const BasePlugin = require("./base.plugin");
const FinancialService = require("../../services/financialService");
const ArCollectionsService = require("../../services/arCollectionsService");

class FinancialPlugin extends BasePlugin {
  constructor() {
    super("FinancialPlugin", "Provides tools for revenue analytics, unpaid invoices, and AR aging buckets.");

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

    // Tool: get_ar_aging_summary
    this.tools["get_ar_aging_summary"] = {
      name: "get_ar_aging_summary",
      description: "Retrieves Accounts Receivable aging buckets (Current, 1-30d, 31-60d, 61-90d, 90+d overdue totals).",
      allowedRoles: ["owner", "admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        const aging = await ArCollectionsService.getAgingSummary(context.user.companyId);
        return { success: true, aging };
      },
    };
  }
}

module.exports = FinancialPlugin;
