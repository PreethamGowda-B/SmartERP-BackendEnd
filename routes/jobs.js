const express = require('express');
const router = express.Router();
const { pool } = require('../db'); // ✅ keep as-is
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Ensure the jobs table can store JSON payloads and visibility flag
 * (SAFE, NON-BREAKING)
 */
const ensureColumns = async () => {
  if (!pool) {
    console.warn("⚠️ Database pool not ready yet. Skipping schema checks.");
    return;
  }

  try {
    await pool.query(
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS data JSONB"
    );
    await pool.query(
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS visible_to_all BOOLEAN DEFAULT false"
    );

    console.log("✅ Jobs table schema verified/updated.");
  } catch (err) {
    console.warn(
      "⚠️ Could not ensure jobs.data/visible_to_all columns exist:",
      err.message || err
    );
  }
};

// Run it asynchronously without blocking startup
setTimeout(ensureColumns, 5000);

/**
 * Create a new job
 */
router.post('/', authenticateToken, async (req, res) => {
  const job = req.body || {};
  const title = job.title || '';
  const description = job.description || '';

  const assignedTo =
    (job.assignedEmployees && job.assignedEmployees[0]) ||
    job.assignedTo ||
    null;

  const visibleToAll =
    job.visible_to_all === false ? false : true;

  try {
    const result = await pool.query(
      `INSERT INTO jobs 
       (title, description, assigned_to, created_by, data, visible_to_all)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        title,
        description,
        assignedTo,
        req.user.id,        // ✅ FIXED (was userId)
        job,
        visibleToAll
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('jobs POST error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Get jobs (role-based)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    let result;

    console.log("🧩 Fetching jobs for:", req.user);

    if (req.user.role === 'owner') {
      result = await pool.query(
        `SELECT * FROM jobs 
         WHERE created_by = $1 
         ORDER BY created_at DESC`,
        [req.user.id]       // ✅ FIXED
      );
    } else if (req.user.role === 'employee') {
      result = await pool.query(
        `SELECT * FROM jobs 
         WHERE visible_to_all = true 
         OR assigned_to = $1 
         ORDER BY created_at DESC`,
        [req.user.id]       // ✅ FIXED
      );
    } else {
      result = await pool.query(
        `SELECT * FROM jobs WHERE visible_to_all = true`
      );
    }

    const rows = result.rows.map((r) => {
      const job = r.data && typeof r.data === 'object' ? r.data : {};
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        priority: r.priority,
        status: r.status,
        visible_to_all: r.visible_to_all,
        created_by: r.created_by,
        assigned_to: r.assigned_to,
        created_at: r.created_at,
        ...job,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error('jobs GET error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Update job
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
         data = CASE 
           WHEN data IS NULL THEN $5 
           ELSE data || $5 
         END
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
    await pool.query(
      'DELETE FROM jobs WHERE id = $1',
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('jobs DELETE error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
