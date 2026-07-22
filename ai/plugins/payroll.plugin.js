const BasePlugin = require("./base.plugin");
const PayrollService = require("../../services/payrollService");

class PayrollPlugin extends BasePlugin {
  constructor() {
    super("PayrollPlugin", "Payroll");

    // Tool: get_payroll_summary
    this.tools["get_payroll_summary"] = {
      name: "get_payroll_summary",
      description: "Retrieves payroll expense breakdown, total wages, and payment statuses for the company.",
      allowedRoles: ["owner", "hr", "admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "Target month" },
          year: { type: "string", description: "Target year" },
        },
      },
      execute: async (params, context) => {
        return await PayrollService.getPayrollSummary({
          companyId: context.user.companyId,
          month: params.month,
          year: params.year,
        });
      },
    };

    // Tool: calculate_payroll
    this.tools["calculate_payroll"] = {
      name: "calculate_payroll",
      description: "Generates monthly payroll records for all active company employees.",
      allowedRoles: ["owner", "hr", "admin"],
      isDestructive: true,
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "Month name or number" },
          year: { type: "string", description: "Year (e.g. '2026')" },
        },
        required: ["month", "year"],
      },
      execute: async (params, context) => {
        return await PayrollService.calculatePayroll({
          companyId: context.user.companyId,
          month: params.month,
          year: params.year,
        });
      },
    };
  }
}

module.exports = PayrollPlugin;
