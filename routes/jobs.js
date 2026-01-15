const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Ensure the jobs table can store JSON payloads, visibility flag, and employee tracking
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
    await pool.query(
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS employee_status VARCHAR(50) DEFAULT 'pending'"
    );
    await pool.query(
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0"
    );
    await pool.query(
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP"
    );
    await pool.query(
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS declined_at TIMESTAMP"
    );
    await pool.query(
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP"
    );
    await pool.query(
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'medium'"
    );

    console.log("✅ Jobs table schema verified/updated with employee tracking columns.");
  } catch (err) {
    console.warn(
      "⚠️ Could not ensure jobs columns exist:",
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
       (title, description, assigned_to, created_by, data, visible_to_all, status, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        title,
        description,
        assignedTo,
        req.user.id,
        job,
        visibleToAll,
        job.status || 'pending',
        job.priority || 'medium'
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
        `SELECT j.*, u.email as employee_email 
         FROM jobs j
         LEFT JOIN users u ON j.assigned_to = u.id
         WHERE j.created_by = $1 
         ORDER BY j.created_at DESC`,
        [req.user.id]
      );
    } else if (req.user.role === 'employee') {
      result = await pool.query(
        `SELECT * FROM jobs 
         WHERE visible_to_all = true 
         OR assigned_to = $1 
         ORDER BY created_at DESC`,
        [req.user.id]
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
        employee_status: r.employee_status,
        progress: r.progress || 0,
        accepted_at: r.accepted_at,
        declined_at: r.declined_at,
        completed_at: r.completed_at,
        employee_email: r.employee_email,
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
 * Accept a job (Employee only)
 */
router.post('/:id/accept', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Check if job is assigned to this employee
    const checkJob = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND (assigned_to = $2 OR visible_to_all = true)',
      [id, req.user.id]
    );

    if (checkJob.rows.length === 0) {
      return res.status(403).json({ message: 'Job not assigned to you' });
    }

    const result = await pool.query(
      `UPDATE jobs 
       SET employee_status = 'accepted', 
           accepted_at = NOW(),
           status = 'active',
           assigned_to = $2
       WHERE id = $1
       RETURNING *`,
      [id, req.user.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('jobs ACCEPT error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Decline a job (Employee only)
 */
router.post('/:id/decline', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Check if job is assigned to this employee
    const checkJob = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND (assigned_to = $2 OR visible_to_all = true)',
      [id, req.user.id]
    );

    if (checkJob.rows.length === 0) {
      return res.status(403).json({ message: 'Job not assigned to you' });
    }

    const result = await pool.query(
      `UPDATE jobs 
       SET employee_status = 'declined', 
           declined_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('jobs DECLINE error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Update job progress (Employee only)
 */
router.post('/:id/progress', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { progress } = req.body;

  if (typeof progress !== 'number' || progress < 0 || progress > 100) {
    return res.status(400).json({ message: 'Progress must be between 0 and 100' });
  }

  try {
    // Check if job is assigned to this employee and accepted
    const checkJob = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND assigned_to = $2 AND employee_status = $3',
      [id, req.user.id, 'accepted']
    );

    if (checkJob.rows.length === 0) {
      return res.status(403).json({ message: 'Job not assigned to you or not accepted' });
    }

    let status = 'active';
    let completed_at = null;

    if (progress === 100) {
      status = 'completed';
      completed_at = new Date();
    }

    const result = await pool.query(
      `UPDATE jobs 
       SET progress = $1, 
           status = $2,
           completed_at = $3
       WHERE id = $4
       RETURNING *`,
      [progress, status, completed_at, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('jobs PROGRESS error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Update job (Owner/Admin)
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

/**
 * Accept a job (Employee only)
 */
router.post('/:id/accept', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const checkJob = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND (assigned_to = $2 OR visible_to_all = true)',
      [id, req.user.id]
    );

    if (checkJob.rows.length === 0) {
      return res.status(403).json({ message: 'Job not assigned to you' });
    }

    const result = await pool.query(
      `UPDATE jobs 
       SET employee_status = 'accepted', 
           accepted_at = NOW(),
           status = 'active',
           assigned_to = $2
       WHERE id = $1
       RETURNING *`,
      [id, req.user.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('jobs ACCEPT error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Decline a job (Employee only)
 */
router.post('/:id/decline', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const checkJob = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND (assigned_to = $2 OR visible_to_all = true)',
      [id, req.user.id]
    );

    if (checkJob.rows.length === 0) {
      return res.status(403).json({ message: 'Job not assigned to you' });
    }

    const result = await pool.query(
      `UPDATE jobs 
       SET employee_status = 'declined', 
           declined_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('jobs DECLINE error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Update job progress (Employee only)
 */
router.post('/:id/progress', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { progress } = req.body;

  if (typeof progress !== 'number' || progress < 0 || progress > 100) {
    return res.status(400).json({ message: 'Progress must be between 0 and 100' });
  }

  try {
    const checkJob = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND assigned_to = $2',
      [id, req.user.id]
    );

    if (checkJob.rows.length === 0) {
      return res.status(403).json({ message: 'Job not assigned to you' });
    }

    let status = 'active';
    let completed_at = null;

    if (progress === 100) {
      status = 'completed';
      completed_at = new Date();
    }

    const result = await pool.query(
      `UPDATE jobs 
       SET progress = $1, 
           status = $2,
           completed_at = $3
       WHERE id = $4
       RETURNING *`,
      [progress, status, completed_at, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('jobs PROGRESS error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
