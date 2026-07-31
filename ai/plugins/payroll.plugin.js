const BasePlugin = require("./base.plugin");
const PayrollService = require("../../services/payrollService");
const PayrollValidationService = require("../../services/payrollValidationService");

class PayrollPlugin extends BasePlugin {
  constructor() {
    super("PayrollPlugin", "Provides tools for payroll processing, expense summaries, and pre-run anomaly detection.");

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

    // Tool: validate_payroll_pre_run
    this.tools["validate_payroll_pre_run"] = {
      name: "validate_payroll_pre_run",
      description: "Executes 7-point pre-run validation audit (ghost employees, duplicate bank accounts, salary spikes, statutory errors) before payroll disbursal.",
      allowedRoles: ["owner", "hr", "admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          month: { type: "integer", description: "Month number 1-12" },
          year: { type: "integer", description: "Year e.g. 2026" },
        },
        required: ["month", "year"],
      },
      execute: async (params, context) => {
        const valRes = await PayrollValidationService.runPreRunValidation({
          companyId: context.user.companyId,
          userId: context.user.userId,
          month: params.month,
          year: params.year,
          proposedPayroll: [],
        });
        return { success: true, validation: valRes };
      },
    };
  }
}

module.exports = PayrollPlugin;
