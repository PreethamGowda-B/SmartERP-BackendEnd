/**
 * routes/customer/reviews.js
 *
 * Customer job reviews — submit and fetch ratings after job completion.
 *
 * Endpoints:
 *   POST /jobs/:id/review  — submit a review (only after completion, one per job)
 *   GET  /jobs/:id/review  — fetch existing review for a job
 */

'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { pool } = require('../../db');

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data, error: null });
}
function fail(res, message, statusCode = 400) {
  return res.status(statusCode).json({ success: false, data: null, error: message });
}

// ── Ensure job_reviews table exists ──────────────────────────────────────────
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_reviews (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id      UUID NOT NULL UNIQUE,
      customer_id UUID NOT NULL,
      employee_id UUID,
      company_id  TEXT,
      rating      SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
      review_text TEXT,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_job_reviews_job_id      ON job_reviews(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_reviews_employee_id ON job_reviews(employee_id);
    CREATE INDEX IF NOT EXISTS idx_job_reviews_customer_id ON job_reviews(customer_id);
  `).catch(() => {});
}

ensureTable();

// ── GET /jobs/:id/review ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const customerId = req.customer.id;
  const jobId      = req.params.id;

  try {
    const result = await pool.query(
      'SELECT * FROM job_reviews WHERE job_id = $1 AND customer_id = $2',
      [jobId, customerId]
    );
    return ok(res, result.rows[0] || null);
  } catch (err) {
    console.error('review GET error:', err.message);
    return fail(res, 'Server error', 500);
  }
});

// ── POST /jobs/:id/review ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const customerId = req.customer.id;
  const companyId  = req.customer.companyId;
  const jobId      = req.params.id;
  const { rating, review_text } = req.body;

  if (!rating || typeof rating !== 'number' || rating < 1 || rating > 5) {
    return fail(res, 'Rating must be a number between 1 and 5', 400);
  }

  try {
    // Verify job ownership and completion
    const jobResult = await pool.query(
      `SELECT id, status, assigned_to, customer_id
       FROM jobs
       WHERE id = $1 AND customer_id = $2 AND company_id::text = $3`,
      [jobId, customerId, String(companyId)]
    );

    if (jobResult.rows.length === 0) {
      return fail(res, 'Job not found', 404);
    }

    const job = jobResult.rows[0];

    if (job.status !== 'completed') {
      return fail(res, 'Reviews can only be submitted after job completion', 403);
    }

    // Check for existing review (one per job)
    const existing = await pool.query(
      'SELECT id FROM job_reviews WHERE job_id = $1',
      [jobId]
    );
    if (existing.rows.length > 0) {
      return fail(res, 'You have already submitted a review for this job', 409);
    }

    // Insert review
    const result = await pool.query(
      `INSERT INTO job_reviews (job_id, customer_id, employee_id, company_id, rating, review_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [jobId, customerId, job.assigned_to || null, String(companyId), rating, review_text?.trim() || null]
    );

    // Update employee rating average (non-blocking)
    if (job.assigned_to) {
      pool.query(
        `UPDATE employee_profiles
         SET rating = (
           SELECT ROUND(AVG(r.rating)::numeric, 2)
           FROM job_reviews r
           WHERE r.employee_id = $1
         )
         WHERE user_id = $1`,
        [job.assigned_to]
      ).catch(e => console.warn('Rating update error (non-fatal):', e.message));
    }

    return ok(res, result.rows[0], 201);
  } catch (err) {
    console.error('review POST error:', err.message);
    return fail(res, 'Server error', 500);
  }
});

module.exports = router;
