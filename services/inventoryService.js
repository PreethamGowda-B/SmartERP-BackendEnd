const { pool } = require("../db");

class InventoryService {
  /**
   * Retrieves items below threshold.
   */
  static async getLowStockItems({ companyId }) {
    if (!companyId) throw new Error("Company ID is required.");

    const res = await pool.query(
      `SELECT id, name, category, quantity, min_quantity, unit
       FROM inventory_items
       WHERE company_id::text = $1
         AND (is_deleted = FALSE OR is_deleted IS NULL)
         AND min_quantity > 0
         AND quantity < min_quantity
       ORDER BY (quantity::float / NULLIF(min_quantity, 0)) ASC`,
      [String(companyId)]
    );

    return {
      lowStockCount: res.rows.length,
      items: res.rows,
    };
  }

  /**
   * Retrieves material requests.
   */
  static async getMaterialRequests({ companyId, status }) {
    if (!companyId) throw new Error("Company ID is required.");

    let query = `
      SELECT id, material_name, quantity, status, requested_by, created_at
      FROM material_requests
      WHERE company_id::text = $1
    `;
    const values = [String(companyId)];

    if (status) {
      query += ` AND LOWER(status) = LOWER($2)`;
      values.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT 20`;
    const res = await pool.query(query, values);

    return {
      requestCount: res.rows.length,
      requests: res.rows,
    };
  }
}

module.exports = InventoryService;
