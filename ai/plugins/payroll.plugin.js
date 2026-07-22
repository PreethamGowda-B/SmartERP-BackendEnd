const BasePlugin = require("./base.plugin");
const { pool } = require("../../db");

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
          month: { type: "string", description: "Target month (e.g. '07' or 'July')" },
          year: { type: "string", description: "Target year (e.g. '2026')" },
        },
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        const res = await pool.query(
          `SELECT id, user_id, amount, status, month, year, created_at
           FROM payroll
           WHERE company_id::text = $1
           ORDER BY created_at DESC LIMIT 50`,
          [String(companyId)]
        );

        const totalExpense = res.rows.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);

        return {
          recordCount: res.rows.length,
          totalExpense: totalExpense.toFixed(2),
          currency: "INR (₹)",
          payrollRecords: res.rows,
        };
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
        const companyId = context.user.companyId;

        // Get all active users
        const usersRes = await pool.query(
          `SELECT id, name, email FROM users WHERE company_id::text = $1 AND is_active = true`,
          [String(companyId)]
        );

        let createdCount = 0;
        for (const user of usersRes.rows) {
          const baseSalary = 35000; // Base default computation
          await pool.query(
            `INSERT INTO payroll (company_id, user_id, amount, status, month, year, created_at)
             VALUES ($1, $2, $3, 'processed', $4, $5, NOW())`,
            [companyId, user.id, baseSalary, params.month, params.year]
          );
          createdCount++;
        }

        return {
          success: true,
          message: `Generated ${createdCount} payroll records for ${params.month}/${params.year}.`,
          processedCount: createdCount,
        };
      },
    };
  }
}

module.exports = PayrollPlugin;
