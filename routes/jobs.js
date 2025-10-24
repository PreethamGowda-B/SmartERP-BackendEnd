const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// Ensure the jobs table can store JSON payloads and visibility flag
const ensureColumns = async () => {
  if (!pool) {
    console.warn("⚠️ Database pool not ready yet. Skipping schema checks.");
    return;
  }

  try {
    await pool.query(`
      ALTER TABLE IF NOT EXISTS jobs
      ADD COLUMN IF NOT EXISTS data JSONB;
    `);

    await pool.query(`
      ALTER TABLE IF NOT EXISTS jobs
      ADD COLUMN IF NOT EXISTS visible_to_all BOOLEAN DEFAULT false;
    `);

    console.log("✅ Jobs table schema verified/updated.");
  } catch (err) {
    console.warn("⚠️ Could not ensure jobs.data/visible_to_all columns exist:", err.message || err);
  }
};

// Run it asynchronously without blocking startup
setTimeout(ensureColumns, 5000);


/**
 * Create a new job
 * Every job created (especially by an owner) is now visible to all employees by default.
 */
router.post('/', authenticateToken, async (req, res) => {
  const job = req.body || {};
  const title = job.title || '';
  const description = job.description || '';

  // Support both assignedEmployees (array) or single assignedTo field
  const assignedTo =
    (job.assignedEmployees && job.assignedEmployees[0]) ||
    job.assignedTo ||
    null;

  // ✅ Force jobs to be visible to all employees by default
  const visibleToAll =
    job.visible_to_all === false ? false : true; // default true unless explicitly false

  try {
    const result = await pool.query(
      `INSERT INTO jobs (title, description, assigned_to, created_by, data, visible_to_all)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title, description, assignedTo, req.user.userId, job, visibleToAll]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('jobs POST error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Get all jobs visible to the current user
 * - Owners: see their created jobs
 * - Employees: see all visible jobs (visible_to_all = true)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    let result;

    if (req.user && req.user.role === 'employee') {
      // ✅ Employees see ALL visible jobs
      result = await pool.query(`SELECT * FROM jobs WHERE visible_to_all = true`);
    } else if (req.user && req.user.role === 'owner') {
      // Owners see all jobs they created
      result = await pool.query(`SELECT * FROM jobs WHERE created_by = $1`, [req.user.userId]);
    } else {
      // Default: return visible jobs if role not identified
      result = await pool.query(`SELECT * FROM jobs WHERE visible_to_all = true`);
    }

    const rows = result.rows.map((r) => {
      if (r.data && typeof r.data === 'object') {
        return {
          ...r.data,
          id: r.id.toString(),
          _db_row: r,
          __assigned_to: r.assigned_to,
          __created_by: r.created_by,
        };
      }
      return {
        id: r.id.toString(),
        title: r.title,
        description: r.description,
        assignedTo: r.assigned_to,
        _db_row: r,
        __assigned_to: r.assigned_to,
        __created_by: r.created_by,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error('jobs GET error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Update job (partial update)
 */
router.put('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const updates = req.body || {};

  try {
    const result = await pool.query(
      `UPDATE jobs SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         assigned_to = COALESCE($3, assigned_to),
         visible_to_all = COALESCE($4, visible_to_all),
         data = CASE WHEN data IS NULL THEN $5 ELSE data || $5 END
       WHERE id = $6
       RETURNING *`,
      [
        updates.title,
        updates.description,
        (updates.assignedEmployees && updates.assignedEmployees[0]) ||
          updates.assignedTo ||
          null,
        typeof updates.visible_to_all !== 'undefined'
          ? updates.visible_to_all
          : null,
        updates,
        id,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('jobs PUT error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Delete job
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM jobs WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('jobs DELETE error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
