const { pool } = require("../db");

class PayrollService {
  /**
   * Retrieves payroll summary metrics.
   */
  static async getPayrollSummary({ companyId, month, year }) {
    if (!companyId) throw new Error("Company ID is required.");

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
  }

  /**
   * Generates company monthly payroll.
   */
  static async calculatePayroll({ companyId, month, year }) {
    if (!companyId || !month || !year) {
      throw new Error("Company ID, month, and year are required to compute payroll.");
    }

    const usersRes = await pool.query(
      `SELECT id, name, email FROM users WHERE company_id::text = $1 AND is_active = true`,
      [String(companyId)]
    );

    let createdCount = 0;
    for (const user of usersRes.rows) {
      const baseSalary = 35000;
      await pool.query(
        `INSERT INTO payroll (company_id, user_id, amount, status, month, year, created_at)
         VALUES ($1, $2, $3, 'processed', $4, $5, NOW())`,
        [companyId, user.id, baseSalary, month, year]
      );
      createdCount++;
    }

    return {
      success: true,
      message: `Generated ${createdCount} payroll records for ${month}/${year}.`,
      processedCount: createdCount,
    };
  }
}

module.exports = PayrollService;
