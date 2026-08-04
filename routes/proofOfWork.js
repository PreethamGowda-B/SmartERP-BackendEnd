const express = require("express");
const router = express.Router({ mergeParams: true });
const { pool } = require("../db");
const { authenticateToken } = require("../middleware/authMiddleware");
const { requireClockIn } = require("../middleware/attendanceGatekeeperMiddleware");
const { createNotification, createNotificationForOwners } = require("../utils/notificationHelpers");
const EventMessagingService = require('../services/eventMessagingService');

// Ensure proof_of_work table exists in database lazily
let isInitialized = false;
async function ensureDbInitialized() {
  if (isInitialized) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS job_proof_of_work (
        id SERIAL PRIMARY KEY,
        job_id TEXT NOT NULL,
        company_id INT,
        uploaded_by_id TEXT,
        uploaded_by_name TEXT,
        photo_url TEXT,
        notes TEXT,
        gps_latitude NUMERIC,
        gps_longitude NUMERIC,
        stage TEXT DEFAULT 'in_progress',
        customer_signature_url TEXT,
        signed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    isInitialized = true;
  } catch (err) {
    console.warn("⚠️ Warning initializing job_proof_of_work table (will retry on request):", err.message);
  }
}
// Deferred initialization
setTimeout(ensureDbInitialized, 2000);

// ── 1. POST /api/jobs/:id/proof-of-work ─────────────────────────────────────
// Submit site photo, progress notes, and GPS check-in (Field Technicians)
router.post("/:id/proof-of-work", authenticateToken, requireClockIn, async (req, res) => {
  try {
    await ensureDbInitialized();
    const jobId = req.params.id;
    const { photo_url, notes, gps_latitude, gps_longitude, stage = "in_progress" } = req.body;
    const userId = req.user?.userId || req.user?.id;
    const userName = req.user?.name || "Technician";
    const companyId = req.user?.companyId;

    if (!photo_url && !notes) {
      return res.status(400).json({ message: "Photo URL or site notes are required." });
    }

    const result = await pool.query(
      `INSERT INTO job_proof_of_work 
       (job_id, company_id, uploaded_by_id, uploaded_by_name, photo_url, notes, gps_latitude, gps_longitude, stage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [jobId, companyId, userId, userName, photo_url || null, notes || null, gps_latitude || null, gps_longitude || null, stage]
    );

    // Update job stage if provided
    await pool.query(
      `UPDATE jobs SET stage = $1, updated_at = NOW() WHERE id = $2`,
      [stage, jobId]
    );

    // Notify Owner
    try {
      await createNotificationForOwners({
        company_id: companyId,
        type: 'proof_of_work',
        title: 'Site Proof Uploaded',
        message: `📸 Site Proof Uploaded: ${userName} uploaded site proof photo for job #${jobId.substring(0, 8)}`,
        priority: 'medium',
        actor_id: userId,
        data: { job_id: jobId, url: '/owner/jobs' }
      });
    } catch (nErr) {
      console.warn('⚠️ Proof of work notification warning:', nErr.message);
    }

    // Auto-post proof image to job conversation thread (Enterprise Communication Backbone)
    EventMessagingService.onProofUploaded({
      jobId,
      companyId,
      photoUrl: photo_url || '',
      notes: notes || '',
      technicianName: userName,
      senderId: userId,
    }).catch(() => {}); // non-blocking

    return res.status(201).json({
      success: true,
      message: "Site proof of work uploaded successfully.",
      proof: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Error uploading proof of work:", err);
    return res.status(500).json({ message: "Failed to upload proof of work." });
  }
});

// ── 2. GET /api/jobs/:id/proof-of-work ──────────────────────────────────────
// Fetch complete audit trail of site proof photos, GPS, & signatures
router.get("/:id/proof-of-work", async (req, res) => {
  try {
    const jobId = req.params.id;
    const result = await pool.query(
      `SELECT * FROM job_proof_of_work WHERE job_id = $1 ORDER BY created_at ASC`,
      [jobId]
    );
    return res.json({
      success: true,
      proofs: result.rows,
    });
  } catch (err) {
    console.error("❌ Error fetching proof of work:", err);
    return res.status(500).json({ message: "Failed to fetch proof of work." });
  }
});

// ── 3. POST /api/jobs/:id/customer-signoff ──────────────────────────────────
// Customer E-Signature sign-off approval (Customer Portal)
router.post("/:id/customer-signoff", async (req, res) => {
  try {
    const jobId = req.params.id;
    const { signature_url, feedback_rating, customer_notes } = req.body;

    if (!signature_url) {
      return res.status(400).json({ message: "Digital customer signature is required." });
    }

    // Save sign-off record
    const result = await pool.query(
      `INSERT INTO job_proof_of_work 
       (job_id, notes, stage, customer_signature_url, signed_at)
       VALUES ($1, $2, 'completed', $3, NOW())
       RETURNING *`,
      [jobId, customer_notes ? `Customer Feedback: ${customer_notes}` : "Customer Digital Sign-off Completed", signature_url]
    );

    // Auto-complete job & update status
    await pool.query(
      `UPDATE jobs SET status = 'completed', stage = 'Completed', progress = 100, updated_at = NOW() WHERE id = $1`,
      [jobId]
    );

    // Check if invoice exists; if not, create draft invoice automatically
    try {
      const invCheck = await pool.query(`SELECT id FROM invoices WHERE job_id = $1`, [jobId]);
      if (invCheck.rows.length === 0) {
        const jobRes = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
        if (jobRes.rows.length > 0) {
          const j = jobRes.rows[0];
          const invNum = `INV-${Date.now()}-${String(jobId).substring(0, 8).toUpperCase()}`;
          const totalAmt = Number(j.budget || j.estimated_cost || 0);

          await pool.query(
            `INSERT INTO invoices (company_id, job_id, invoice_number, total_amount, status)
             VALUES ($1, $2, $3, $4, 'issued')`,
            [j.company_id || 1, jobId, invNum, totalAmt]
          );
        }
      }
    } catch (invErr) {
      console.warn("⚠️ Could not auto-generate invoice upon customer signoff:", invErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Customer digital sign-off completed & job verified.",
      signoff: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Error processing customer sign-off:", err);
    return res.status(500).json({ message: "Failed to process customer sign-off." });
  }
});

module.exports = router;
