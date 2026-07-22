const { pool } = require("../db");

class JobService {
  /**
   * Retrieves company jobs with optional status filter.
   */
  static async getJobs({ companyId, status, limit = 50 }) {
    if (!companyId) throw new Error("Company ID is required.");

    let query = `
      SELECT id, title, description, status, priority, created_at, updated_at
      FROM jobs
      WHERE company_id::text = $1
    `;
    const values = [String(companyId)];

    if (status) {
      query += ` AND LOWER(status) = LOWER($2)`;
      values.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT ${limit}`;
    const res = await pool.query(query, values);

    return {
      totalCount: res.rows.length,
      jobs: res.rows.map((j) => ({
        id: j.id,
        title: j.title,
        description: j.description || "",
        status: j.status || "open",
        priority: j.priority || "medium",
        createdAt: j.created_at,
      })),
    };
  }

  /**
   * Identifies delayed or overdue jobs.
   */
  static async getDelayedJobs({ companyId }) {
    if (!companyId) throw new Error("Company ID is required.");

    const res = await pool.query(
      `SELECT id, title, status, priority, created_at
       FROM jobs
       WHERE company_id::text = $1
         AND status NOT IN ('completed', 'closed', 'cancelled')
         AND created_at < NOW() - INTERVAL '7 days'
       ORDER BY created_at ASC`,
      [String(companyId)]
    );

    return {
      delayedCount: res.rows.length,
      delayedJobs: res.rows,
    };
  }

  /**
   * Creates a new job.
   */
  static async createJob({ companyId, title, description, priority }) {
    if (!companyId || !title) {
      throw new Error("Company ID and job title are required.");
    }

    const res = await pool.query(
      `INSERT INTO jobs (title, description, priority, status, company_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'open', $4, NOW(), NOW())
       RETURNING id, title, priority, status, created_at`,
      [title, description || "", priority || "medium", companyId]
    );

    return {
      success: true,
      message: `Job '${title}' created successfully.`,
      job: res.rows[0],
    };
  }
}

module.exports = JobService;
