const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Normalize user id from JWT
 * (your token sometimes has userId, sometimes id)
 */
const getUserId = (req) => req.user.userId || req.user.id;

/**
 * =========================
 * CREATE JOB (OWNER)
 * =========================
 */
router.post('/', authenticateToken, async (req, res) => {
  const job = req.body || {};
  const title = job.title || '';
  const description = job.description || '';

  const assignedTo =
    (Array.isArray(job.assignedEmployees) && job.assignedEmployees[0]) ||
    job.assignedTo ||
    null;

  const visibleToAll =
    typeof job.visibleToAll === 'boolean' ? job.visibleToAll : false;

  const userId = getUserId(req);

  try {
    const result = await pool.query(
      `
      INSERT INTO jobs
        (title, description, assigned_to, created_by, data, visible_to_all, status, priority)
      VALUES
        ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      RETURNING *
      `,
      [
        title,
        description,
        assignedTo,
        userId,                       // ✅ FIXED
        JSON.stringify(job),          // ✅ JSONB SAFE
        visibleToAll,
        job.status || 'PENDING',      // ✅ MATCHES DB CONSTRAINT
        job.priority || 'medium'
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('🔥 CREATE JOB ERROR 🔥');
    console.error(err.message);
    console.error(err.stack);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * =========================
 * GET JOBS (ROLE BASED)
 * =========================
 */
router.get('/', authenticateToken, async (req, res) => {
  const userId = getUserId(req);

  try {
    let result;

    if (req.user.role === 'owner') {
      result = await pool.query(
        `
        SELECT j.*, u.email AS employee_email
        FROM jobs j
        LEFT JOIN users u ON j.assigned_to = u.id
        WHERE j.created_by = $1
        ORDER BY j.created_at DESC
        `,
        [userId] // ✅ FIXED
      );
    } else if (req.user.role === 'employee') {
      result = await pool.query(
        `
        SELECT *
        FROM jobs
        WHERE
          visible_to_all = true
          OR assigned_to = $1
          OR (
            data->'assignedEmployees' IS NOT NULL
            AND data->'assignedEmployees' @> to_jsonb(ARRAY[$1]::int[])
          )
        ORDER BY created_at DESC
        `,
        [userId]
      );
    } else {
      result = await pool.query(
        `SELECT * FROM jobs WHERE visible_to_all = true`
      );
    }

    const rows = result.rows.map((r) => {
      const jobData = r.data && typeof r.data === 'object' ? r.data : {};
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
        ...jobData
      };
    });

    res.json(rows);
  } catch (err) {
    console.error('🔥 GET JOBS ERROR 🔥');
    console.error(err.message);
    console.error(err.stack);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * =========================
 * ACCEPT JOB (EMPLOYEE)
 * =========================
 */
router.post('/:id/accept', authenticateToken, async (req, res) => {
  const jobId = req.params.id;
  const userId = getUserId(req);

  try {
    const check = await pool.query(
      `
      SELECT * FROM jobs
      WHERE id = $1 AND (
        visible_to_all = true
        OR assigned_to = $2
        OR (
          data->'assignedEmployees' IS NOT NULL
          AND data->'assignedEmployees' @> to_jsonb(ARRAY[$2]::int[])
        )
      )
      `,
      [jobId, userId]
    );

    if (check.rows.length === 0) {
      return res.status(403).json({ message: 'Job not assigned to you' });
    }

    const result = await pool.query(
      `
      UPDATE jobs
      SET
        employee_status = 'accepted',
        accepted_at = NOW(),
        status = 'IN_PROGRESS',
        assigned_to = $2
      WHERE id = $1
      RETURNING *
      `,
      [jobId, userId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('🔥 ACCEPT JOB ERROR 🔥');
    console.error(err.message);
    console.error(err.stack);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * =========================
 * DECLINE JOB (EMPLOYEE)
 * =========================
 */
router.post('/:id/decline', authenticateToken, async (req, res) => {
  const jobId = req.params.id;
  const userId = getUserId(req);

  try {
    const result = await pool.query(
      `
      UPDATE jobs
      SET
        employee_status = 'declined',
        declined_at = NOW()
      WHERE id = $1
        AND (assigned_to = $2 OR visible_to_all = true)
      RETURNING *
      `,
      [jobId, userId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('🔥 DECLINE JOB ERROR 🔥');
    console.error(err.message);
    console.error(err.stack);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * =========================
 * UPDATE PROGRESS (EMPLOYEE)
 * =========================
 */
router.post('/:id/progress', authenticateToken, async (req, res) => {
  const jobId = req.params.id;
  const userId = getUserId(req);
  const { progress } = req.body;

  if (typeof progress !== 'number' || progress < 0 || progress > 100) {
    return res.status(400).json({ message: 'Progress must be between 0 and 100' });
  }

  try {
    const status = progress === 100 ? 'COMPLETED' : 'IN_PROGRESS';
    const completedAt = progress === 100 ? new Date() : null;

    const result = await pool.query(
      `
      UPDATE jobs
      SET
        progress = $1,
        status = $2,
        completed_at = $3
      WHERE id = $4
        AND assigned_to = $5
        AND employee_status = 'accepted'
      RETURNING *
      `,
      [progress, status, completedAt, jobId, userId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('🔥 UPDATE PROGRESS ERROR 🔥');
    console.error(err.message);
    console.error(err.stack);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * =========================
 * DELETE JOB (OWNER)
 * =========================
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  const jobId = req.params.id;
  const userId = getUserId(req);

  try {
    await pool.query(
      `DELETE FROM jobs WHERE id = $1 AND created_by = $2`,
      [jobId, userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('🔥 DELETE JOB ERROR 🔥');
    console.error(err.message);
    console.error(err.stack);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
