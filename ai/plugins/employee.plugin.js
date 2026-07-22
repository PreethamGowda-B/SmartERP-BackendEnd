const BasePlugin = require("./base.plugin");
const { pool } = require("../../db");

class EmployeePlugin extends BasePlugin {
  constructor() {
    super("EmployeePlugin", "Employees");

    // Tool: get_employees
    this.tools["get_employees"] = {
      name: "get_employees",
      description: "Retrieves list of employees for the company, with optional department/status filtering.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          department: { type: "string", description: "Filter by department (e.g. Engineering, Sales, Field Support)" },
          status: { type: "string", description: "Filter by status: 'active' or 'inactive'" },
        },
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        let query = `
          SELECT id, name, email, phone, position, department, is_active, role, rating, created_at
          FROM users
          WHERE company_id::text = $1
        `;
        const values = [String(companyId)];
        let paramIdx = 2;

        if (params.department) {
          query += ` AND LOWER(department) = LOWER($${paramIdx})`;
          values.push(params.department);
          paramIdx++;
        }

        if (params.status) {
          const isActive = params.status.toLowerCase() === "active";
          query += ` AND is_active = $${paramIdx}`;
          values.push(isActive);
          paramIdx++;
        }

        query += ` ORDER BY created_at DESC`;

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
          })),
        };
      },
    };

    // Tool: create_employee
    this.tools["create_employee"] = {
      name: "create_employee",
      description: "Creates a new employee profile in SmartERP.",
      allowedRoles: ["owner", "hr", "admin"],
      isDestructive: true,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full name of employee" },
          email: { type: "string", description: "Email address" },
          position: { type: "string", description: "Job title / position" },
          department: { type: "string", description: "Department name" },
        },
        required: ["name", "email"],
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        const bcrypt = require("bcrypt");
        const defaultPasswordHash = await bcrypt.hash("SmartERP@123", 10);

        const res = await pool.query(
          `INSERT INTO users (name, email, password, position, department, company_id, role, is_active, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'employee', true, NOW())
           RETURNING id, name, email, position, department`,
          [params.name, params.email, defaultPasswordHash, params.position || "Staff", params.department || "General", companyId]
        );

        return {
          success: true,
          message: `Employee '${params.name}' created successfully with temporary default password.`,
          employee: res.rows[0],
        };
      },
    };

    // Skill: analyze_employee_performance
    this.skills["analyze_employee_performance"] = {
      name: "analyze_employee_performance",
      description: "Cross-module skill that analyzes top performing employees based on rating and active roles.",
      allowedRoles: ["owner", "hr", "admin"],
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        const res = await pool.query(
          `SELECT id, name, email, position, department, rating, review_count
           FROM users
           WHERE company_id::text = $1 AND is_active = true
           ORDER BY rating DESC NULLS LAST LIMIT 10`,
          [String(companyId)]
        );

        return {
          analysis: "Employee performance ranking based on current ratings and client reviews.",
          topPerformers: res.rows,
        };
      },
    };
  }
}

module.exports = EmployeePlugin;
