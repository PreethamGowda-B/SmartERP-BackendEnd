const { pool } = require("../db");

class CustomerService {
  /**
   * Retrieves customer directory for company.
   */
  static async getCustomers({ companyId, search }) {
    if (!companyId) throw new Error("Company ID is required.");

    let query = `
      SELECT id, name, email, phone, company_name, address, status, created_at
      FROM customers
      WHERE company_id::text = $1
    `;
    const values = [String(companyId)];

    if (search) {
      query += ` AND (LOWER(name) LIKE LOWER($2) OR LOWER(email) LIKE LOWER($2) OR LOWER(company_name) LIKE LOWER($2))`;
      values.push(`%${search}%`);
    }

    query += ` ORDER BY created_at DESC LIMIT 50`;
    const res = await pool.query(query, values);

    return {
      totalCount: res.rows.length,
      customers: res.rows,
    };
  }

  /**
   * Creates a new customer.
   */
  static async createCustomer({ companyId, name, email, phone, companyName }) {
    if (!companyId || !name) {
      throw new Error("Company ID and customer name are required.");
    }

    const res = await pool.query(
      `INSERT INTO customers (name, email, phone, company_name, company_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW())
       RETURNING id, name, email, phone, company_name, created_at`,
      [name, email || "", phone || "", companyName || "", companyId]
    );

    return {
      success: true,
      message: `Customer '${name}' created successfully.`,
      customer: res.rows[0],
    };
  }
}

module.exports = CustomerService;
