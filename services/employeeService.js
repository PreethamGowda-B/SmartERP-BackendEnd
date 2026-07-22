const { pool } = require("../db");

class EmployeeService {
  /**
   * Retrieves employees scoped to the company ID.
   * @param {Object} params
   * @param {string} params.companyId - Tenant Company ID
   * @param {string} [params.department] - Department filter
   * @param {string} [params.status] - 'active' or 'inactive'
   * @param {number} [params.limit] - Record limit
   */
  static async getEmployees({ companyId, department, status, limit = 50 }) {
    if (!companyId) throw new Error("Company ID is required.");

    let query = `
      SELECT id, name, email, phone, position, department, is_active, role, rating, created_at
      FROM users
      WHERE company_id::text = $1
    `;
    const values = [String(companyId)];
    let paramIdx = 2;

    if (department) {
      query += ` AND LOWER(department) = LOWER($${paramIdx})`;
      values.push(department);
      paramIdx++;
    }

    if (status) {
      const isActive = status.toLowerCase() === "active";
      query += ` AND is_active = $${paramIdx}`;
      values.push(isActive);
      paramIdx++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
    values.push(limit);

    const res = await pool.query(query, values);
    return {
      totalCount: res.rows.length,
      employees: res.rows.map((r) => ({
        id: r.id,
        name: r.name || r.email.split("@")[0],
        email: r.email,
        phone: r.phone || "N/A",
        position: r.position || "Employee",
        department: r.department || "General",
        status: r.is_active ? "active" : "inactive",
        role: r.role || "employee",
        rating: r.rating ? parseFloat(r.rating) : null,
        created_at: r.created_at,
      })),
    };
  }

  /**
   * Creates a new employee record.
   * @param {Object} params
   * @param {string} params.companyId
   * @param {string} params.name
   * @param {string} params.email
   * @param {string} [params.position]
   * @param {string} [params.department]
   */
  static async createEmployee({ companyId, name, email, position, department }) {
    if (!companyId || !name || !email) {
      throw new Error("Company ID, name, and email are required to create an employee.");
    }

    const bcrypt = require("bcrypt");
    const defaultPasswordHash = await bcrypt.hash("SmartERP@123", 10);

    const res = await pool.query(
      `INSERT INTO users (name, email, password, position, department, company_id, role, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'employee', true, NOW())
       RETURNING id, name, email, position, department, is_active, created_at`,
      [name, email, defaultPasswordHash, position || "Staff", department || "General", companyId]
    );

    return {
      success: true,
      message: `Employee '${name}' created successfully.`,
      employee: res.rows[0],
    };
  }

  /**
   * Evaluates top performing employees by client review ratings.
   */
  static async getTopPerformers({ companyId, limit = 10 }) {
    if (!companyId) throw new Error("Company ID is required.");

    const res = await pool.query(
      `SELECT id, name, email, position, department, rating, review_count
       FROM users
       WHERE company_id::text = $1 AND is_active = true
       ORDER BY rating DESC NULLS LAST LIMIT $2`,
      [String(companyId), limit]
    );

    return {
      analysis: "Top performing employees ranked by ratings.",
      topPerformers: res.rows,
    };
  }
}

module.exports = EmployeeService;
