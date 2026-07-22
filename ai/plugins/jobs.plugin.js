const BasePlugin = require("./base.plugin");
const { pool } = require("../../db");

class JobsPlugin extends BasePlugin {
  constructor() {
    super("JobsPlugin", "Jobs");

    // Tool: get_jobs
    this.tools["get_jobs"] = {
      name: "get_jobs",
      description: "Retrieves company jobs with optional status filter ('completed', 'in_progress', 'pending', 'open').",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by job status: 'completed', 'in_progress', 'pending', 'open'" },
          limit: { type: "number", description: "Max records to return (default 20)" },
        },
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        const limit = params.limit || 20;
        let query = `
          SELECT id, title, description, status, priority, created_at, updated_at
          FROM jobs
          WHERE company_id::text = $1
        `;
        const values = [String(companyId)];

        if (params.status) {
          query += ` AND LOWER(status) = LOWER($2)`;
          values.push(params.status);
        }

        query += ` ORDER BY created_at DESC LIMIT ${limit}`;

        const res = await pool.query(query, values);
        return {
          totalReturned: res.rows.length,
          jobs: res.rows.map((j) => ({
            id: j.id,
            title: j.title,
            description: j.description || "",
            status: j.status || "open",
            priority: j.priority || "medium",
            createdAt: j.created_at,
          })),
        };
      },
    };

    // Tool: get_delayed_jobs
    this.tools["get_delayed_jobs"] = {
      name: "get_delayed_jobs",
      description: "Identifies overdue or delayed jobs that are not yet completed.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        const query = `
          SELECT id, title, status, priority, created_at
          FROM jobs
          WHERE company_id::text = $1
            AND status NOT IN ('completed', 'closed', 'cancelled')
            AND created_at < NOW() - INTERVAL '7 days'
          ORDER BY created_at ASC
        `;
        const res = await pool.query(query, [String(companyId)]);

        return {
          delayedCount: res.rows.length,
          delayedJobs: res.rows,
        };
      },
    };

    // Tool: create_job
    this.tools["create_job"] = {
      name: "create_job",
      description: "Creates a new job in SmartERP.",
      allowedRoles: ["owner", "hr", "admin"],
      isDestructive: true,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Job title / title of task" },
          description: { type: "string", description: "Detailed description" },
          priority: { type: "string", description: "Priority: 'low', 'medium', 'high', 'urgent'" },
        },
        required: ["title"],
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        const res = await pool.query(
          `INSERT INTO jobs (title, description, priority, status, company_id, created_at, updated_at)
           VALUES ($1, $2, $3, 'open', $4, NOW(), NOW())
           RETURNING id, title, priority, status`,
          [params.title, params.description || "", params.priority || "medium", companyId]
        );

        return {
          success: true,
          message: `Job '${params.title}' created successfully.`,
          job: res.rows[0],
        };
      },
    };

    // Skill: detect_job_bottlenecks
    this.skills["detect_job_bottlenecks"] = {
      name: "detect_job_bottlenecks",
      description: "Analyzes open job volume and flags operational bottlenecks.",
      allowedRoles: ["owner", "hr", "admin"],
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        const res = await pool.query(
          `SELECT status, COUNT(*) as count
           FROM jobs
           WHERE company_id::text = $1
           GROUP BY status`,
          [String(companyId)]
        );

        return {
          summary: "Job status breakdown analysis.",
          breakdown: res.rows,
        };
      },
    };
  }
}

module.exports = JobsPlugin;
