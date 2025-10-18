const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// Ensure the jobs table can store JSON payloads (best-effort). This runs once
// when the module is loaded. If the DB user doesn't have permission this will
// log a warning but won't crash the server.
(async function ensureColumns() {
  try {
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS data JSONB");
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS visible_to_all BOOLEAN DEFAULT false");
  } catch (err) {
    console.warn('Could not ensure jobs.data column exists:', err.message || err);
  }
})();

// Create job - accepts a full job object in the body and stores it in the
// data JSONB column while also populating some top-level columns for search.
router.post('/', authenticateToken, async (req, res) => {
  const job = req.body || {}
  const title = job.title || ''
  const description = job.description || ''
  // Support assignedEmployees (array) or assignedTo (single id)
  const assignedTo = (job.assignedEmployees && job.assignedEmployees[0]) || job.assignedTo || null
  // Determine visible_to_all: if owner created and not explicitly false, default true
  const visibleToAll = typeof job.visible_to_all !== 'undefined' ? Boolean(job.visible_to_all) : (req.user && req.user.role === 'owner')
  try {
    const result = await pool.query(
      'INSERT INTO jobs (title, description, assigned_to, created_by, data, visible_to_all) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [title, description, assignedTo, req.user.userId, job, visibleToAll]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('jobs POST error', err)
    res.status(500).json({ message: 'Server error' })
  }
})

// List jobs for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Fetch jobs where the user is the creator, explicitly assigned via the top-level column,
    // or is listed inside the data.assignedEmployees JSONB array.
    // Use a JSONB containment check to avoid returning every row with non-null data.
    const userJsonArray = JSON.stringify([String(req.user.userId)])
    let result

    // If the requester is an employee, also include jobs created by owners so
    // employees see owner-created jobs even when not explicitly assigned.
    if (req.user && req.user.role === 'employee') {
      // For employees: include owner-created jobs only if the job has visible_to_all = true
      result = await pool.query(
        `SELECT * FROM jobs
         WHERE created_by = $1
           OR assigned_to = $1
           OR COALESCE((data->'assignedEmployees')::jsonb, '[]'::jsonb) @> $2::jsonb
           OR (visible_to_all = true AND EXISTS (SELECT 1 FROM users u WHERE u.id = jobs.created_by AND u.role = 'owner'))`,
        [req.user.userId, userJsonArray]
      )
    } else {
      result = await pool.query(
        `SELECT * FROM jobs
         WHERE created_by = $1
           OR assigned_to = $1
           OR COALESCE((data->'assignedEmployees')::jsonb, '[]'::jsonb) @> $2::jsonb`,
        [req.user.userId, userJsonArray]
      )
    }

    // Merge top-level fields with data JSON and filter server-side to include jobs
    // where the current user is an assignee (either assigned_to or within data.assignedEmployees)
    const rows = result.rows
      .map((r) => {
        if (r.data && typeof r.data === 'object') {
          return { ...r.data, id: r.id.toString(), _db_row: r, __assigned_to: r.assigned_to, __created_by: r.created_by }
        }
        return { id: r.id.toString(), title: r.title, description: r.description, assignedTo: r.assigned_to, _db_row: r, __assigned_to: r.assigned_to, __created_by: r.created_by }
      })
      .filter((job) => {
        // Owner/creator always sees their created jobs
        if (job.__created_by === req.user.userId) return true

        // If top-level assigned_to matches
        if (job.__assigned_to === req.user.userId) return true

        // If job data contains assignedEmployees array, check inclusion
        try {
          const assigned = job.assignedEmployees || job.assigned_to || job.assignedTo
          if (Array.isArray(assigned)) {
            // allow numeric or string ids
            return assigned.some((a) => String(a) === String(req.user.userId))
          }
        } catch (err) {
          // ignore
        }

        return false
      })

    res.json(rows)
  } catch (err) {
    console.error('jobs GET error', err)
    res.status(500).json({ message: 'Server error' })
  }
})

// Update job (partial)
router.put('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params
  const updates = req.body || {}
  try {
    // Try to update top-level fields and merge JSON data
    const result = await pool.query(
      `UPDATE jobs SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         assigned_to = COALESCE($3, assigned_to),
         visible_to_all = COALESCE($4, visible_to_all),
         data = CASE WHEN data IS NULL THEN $5 ELSE data || $5 END
       WHERE id = $6 RETURNING *`,
      [
        updates.title,
        updates.description,
        (updates.assignedEmployees && updates.assignedEmployees[0]) || updates.assignedTo || null,
        typeof updates.visible_to_all !== 'undefined' ? updates.visible_to_all : null,
        updates,
        id,
      ]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('jobs PUT error', err)
    res.status(500).json({ message: 'Server error' })
  }
})

// Delete job
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params
  try {
    await pool.query('DELETE FROM jobs WHERE id = $1', [id])
    res.json({ success: true })
  } catch (err) {
    console.error('jobs DELETE error', err)
    res.status(500).json({ message: 'Server error' })
  }
})

module.exports = router