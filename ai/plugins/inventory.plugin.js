const BasePlugin = require("./base.plugin");
const { pool } = require("../../db");

class InventoryPlugin extends BasePlugin {
  constructor() {
    super("InventoryPlugin", "Inventory");

    // Tool: get_low_stock_items
    this.tools["get_low_stock_items"] = {
      name: "get_low_stock_items",
      description: "Retrieves inventory items running low or below minimum threshold.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        const res = await pool.query(
          `SELECT id, name, category, quantity, min_quantity, unit
           FROM inventory
           WHERE company_id::text = $1 AND (quantity <= min_quantity OR quantity < 10)
           ORDER BY quantity ASC`,
          [String(companyId)]
        );

        return {
          lowStockCount: res.rows.length,
          items: res.rows,
        };
      },
    };

    // Tool: get_material_requests
    this.tools["get_material_requests"] = {
      name: "get_material_requests",
      description: "Retrieves material and inventory reorder requests for the company.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter status: 'pending', 'approved', 'rejected'" },
        },
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        let query = `
          SELECT id, material_name, quantity, status, requested_by, created_at
          FROM material_requests
          WHERE company_id::text = $1
        `;
        const values = [String(companyId)];

        if (params.status) {
          query += ` AND LOWER(status) = LOWER($2)`;
          values.push(params.status);
        }

        query += ` ORDER BY created_at DESC LIMIT 20`;
        const res = await pool.query(query, values);

        return {
          requestCount: res.rows.length,
          requests: res.rows,
        };
      },
    };
  }
}

module.exports = InventoryPlugin;
