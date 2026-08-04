const BasePlugin = require("./base.plugin");
const AIDataService = require("../../services/aiDataService");

class LiveSummaryPlugin extends BasePlugin {
  constructor() {
    super("LiveSummaryPlugin", "Live ERP Summaries");

    // Tool: get_owner_metrics
    this.tools["get_owner_metrics"] = {
      name: "get_owner_metrics",
      description: "Retrieves live company business metrics for Owners/Admins (completed jobs, pending jobs, today/monthly revenue, pending invoices, active headcount, low stock items, pending leaves).",
      allowedRoles: ["owner", "admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        return await AIDataService.getOwnerDashboardSummary({
          companyId: context.user.companyId,
        });
      },
    };

    // Tool: get_employee_personal_summary
    this.tools["get_employee_personal_summary"] = {
      name: "get_employee_personal_summary",
      description: "Retrieves personal workspace metrics for the logged-in employee (assigned jobs, completed count, attendance log, leave requests, material requests). Restricted strictly to personal data.",
      allowedRoles: ["employee", "owner", "hr", "admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        return await AIDataService.getEmployeeDashboardSummary({
          userId: context.user.id,
          companyId: context.user.companyId,
        });
      },
    };

    // Tool: get_hr_summary
    this.tools["get_hr_summary"] = {
      name: "get_hr_summary",
      description: "Retrieves HR overview data (pending leave applications, attendance anomalies, department headcount).",
      allowedRoles: ["hr", "owner", "admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        return await AIDataService.getHrDashboardSummary({
          companyId: context.user.companyId,
        });
      },
    };

    // Tool: get_customer_summary
    this.tools["get_customer_summary"] = {
      name: "get_customer_summary",
      description: "Retrieves customer's own jobs and invoices.",
      allowedRoles: ["customer"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        return await AIDataService.getCustomerDashboardSummary({
          customerId: context.user.id,
          email: context.user.email,
          companyId: context.user.companyId,
        });
      },
    };
  }
}

module.exports = LiveSummaryPlugin;
