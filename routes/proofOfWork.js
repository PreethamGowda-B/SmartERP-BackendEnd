const express = require("express");
const router = express.Router({ mergeParams: true });
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { authenticateToken } = require("../middleware/authMiddleware");
const { requireClockIn } = require("../middleware/attendanceGatekeeperMiddleware");
const { createNotification, createNotificationForOwners } = require("../utils/notificationHelpers");
const EventMessagingService = require('../services/eventMessagingService');

// Helper to authenticate request via JWT (supports staff, customer, and signed query tokens)
function resolveCaller(req) {
  if (req.user) return req.user;
  if (req.customer) return { ...req.customer, role: 'customer' };

  const token = req.query?.token ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null) ||
    req.cookies?.customer_access_token || req.cookies?.user_access_token || req.cookies?.access_token;

  if (!token) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded;
  } catch {
    return null;
  }
}

// Ensure proof_of_work table exists in database lazily
let isInitialized = false;
async function ensureDbInitialized() {
  if (isInitialized) return;
  let client;
  try {
    client = await pool.connect();
    await client.query('SET ROLE postgres').catch(() => {});
    await client.query(`
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
    // Fail open if table already exists
  } finally {
    if (client) client.release();
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
    const companyId = req.user?.companyId || req.user?.company_id;

    if (!companyId) {
      return res.status(401).json({ message: "Unauthorized: Missing company context." });
    }

    if (!photo_url && !notes) {
      return res.status(400).json({ message: "Photo URL or site notes are required." });
    }

    // Verify job belongs to technician's company
    const jobCheck = await pool.query(
      `SELECT id, machine_id, title, company_id FROM jobs WHERE id::text = $1::text AND (company_id::text = $2::text OR company_id IS NULL OR $2::text = '1')`,
      [jobId, String(companyId)]
    );
    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ message: "Job not found." });
    }

    const effectiveCompanyId = jobCheck.rows[0].company_id || companyId;

    const result = await pool.query(
      `INSERT INTO job_proof_of_work 
       (job_id, company_id, uploaded_by_id, uploaded_by_name, photo_url, notes, gps_latitude, gps_longitude, stage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [jobId, effectiveCompanyId, userId, userName, photo_url || null, notes || null, gps_latitude || null, gps_longitude || null, stage]
    );

    // Optionally update job status if stage indicates completion or in-progress
    if (stage === 'completed') {
      await pool.query(
        `UPDATE jobs SET status = 'completed', progress = 100, updated_at = NOW() WHERE id::text = $1::text`,
        [jobId]
      ).catch(() => {});
    } else if (stage === 'in_progress') {
      await pool.query(
        `UPDATE jobs SET status = 'in_progress', updated_at = NOW() WHERE id::text = $1::text AND status = 'open'`,
        [jobId]
      ).catch(() => {});
    }

    // Notify Owner
    try {
      await createNotificationForOwners({
        company_id: effectiveCompanyId,
        type: 'proof_of_work',
        title: 'Site Proof Uploaded',
        message: `📸 Site Proof Uploaded: ${userName} uploaded site proof photo for job #${String(jobId).substring(0, 8)}`,
        priority: 'medium',
        actor_id: userId,
        data: { job_id: jobId, url: '/owner/jobs' }
      });
    } catch (nErr) {
      console.warn('⚠️ Proof of work notification warning:', nErr.message);
    }

    // Auto-Trigger Timeline Event on Machine
    try {
      if (jobCheck.rows[0]?.machine_id) {
        await pool.query(
          `INSERT INTO machine_timeline_events (company_id, machine_id, job_id, event_type, title, description, created_at)
           VALUES ($1, $2, $3, 'proof_submitted', 'Site Proof & Progress Uploaded', $4, NOW())`,
          [effectiveCompanyId, jobCheck.rows[0].machine_id, jobId, `Engineer ${userName} uploaded site proof for job ${jobCheck.rows[0].title}. Notes: ${notes || 'No notes'}`]
        );
      }
    } catch (tErr) {
      console.warn('⚠️ Timeline trigger notice:', tErr.message);
    }

    // Auto-post proof image to job conversation thread (Enterprise Communication Backbone)
    EventMessagingService.onProofUploaded({
      jobId,
      companyId: effectiveCompanyId,
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
    const caller = resolveCaller(req);
    if (!caller) {
      return res.status(401).json({ message: "Authentication required." });
    }

    const jobId = req.params.id;

    // Fetch job
    const jobRes = await pool.query(`SELECT * FROM jobs WHERE id::text = $1::text`, [jobId]);
    if (jobRes.rows.length === 0) {
      return res.status(404).json({ message: "Job not found." });
    }

    const job = jobRes.rows[0];
    const callerCompanyId = String(caller.companyId || caller.company_id || '');
    const callerId = String(caller.id || caller.userId || caller.customerId || '');
    const callerRole = caller.role || '';

    // Authorization check
    const isSuperAdmin = callerRole === 'super_admin' || caller.isSuperAdmin;
    const isCompanyStaff = callerCompanyId && (callerCompanyId === String(job.company_id) || callerCompanyId === '1' || !job.company_id);
    const isAssignedTech = callerId && (callerId === String(job.assigned_to) || callerId === String(job.assigned_employee_id));
    const isAuthorizedCustomer = job.customer_id && callerId === String(job.customer_id);

    if (!isSuperAdmin && !isCompanyStaff && !isAssignedTech && !isAuthorizedCustomer) {
      return res.status(403).json({ message: "Access denied: You are not authorized to view proof of work for this job." });
    }

    const result = await pool.query(
      `SELECT * FROM job_proof_of_work WHERE job_id::text = $1::text ORDER BY created_at ASC`,
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
// Customer E-Signature sign-off approval (Customer Portal & On-site Technician)
router.post("/:id/customer-signoff", async (req, res) => {
  try {
    const caller = resolveCaller(req);
    if (!caller) {
      return res.status(401).json({ message: "Authentication required for customer sign-off." });
    }

    const jobId = req.params.id;
    const { signature_url, feedback_rating, customer_notes } = req.body;

    if (!signature_url) {
      return res.status(400).json({ message: "Digital customer signature is required." });
    }

    // Look up job in DB
    const jobRes = await pool.query(
      `SELECT id, company_id, customer_id, title, budget, estimated_cost, status, assigned_to, assigned_employee_id FROM jobs WHERE id::text = $1::text`,
      [jobId]
    );

    if (jobRes.rows.length === 0) {
      return res.status(404).json({ message: "Job not found." });
    }

    const job = jobRes.rows[0];
    const callerCompanyId = String(caller.companyId || caller.company_id || '');
    const callerId = String(caller.id || caller.userId || caller.customerId || '');
    const callerRole = caller.role || '';

    // Authorization: Can be SuperAdmin, Company Staff/Technician on-site collecting sign-off, or the Job Customer
    const isSuperAdmin = callerRole === 'super_admin' || caller.isSuperAdmin;
    const isCompanyStaff = callerCompanyId && (callerCompanyId === String(job.company_id) || callerCompanyId === '1' || !job.company_id);
    const isAssignedTech = callerId && (callerId === String(job.assigned_to) || callerId === String(job.assigned_employee_id));
    const isJobCustomer = job.customer_id && callerId === String(job.customer_id);

    if (!isSuperAdmin && !isCompanyStaff && !isAssignedTech && !isJobCustomer) {
      return res.status(403).json({ message: "Access denied: You are not authorized to submit customer sign-off for this job." });
    }

    // Save sign-off record
    const result = await pool.query(
      `INSERT INTO job_proof_of_work 
       (job_id, company_id, notes, stage, customer_signature_url, signed_at)
       VALUES ($1, $2, $3, 'completed', $4, NOW())
       RETURNING *`,
      [jobId, job.company_id, customer_notes ? `Customer Feedback: ${customer_notes}` : "Customer Digital Sign-off Completed", signature_url]
    );

    // Auto-complete job & update status
    await pool.query(
      `UPDATE jobs SET status = 'completed', progress = 100, updated_at = NOW() WHERE id::text = $1::text`,
      [jobId]
    ).catch(() => {});

    // Check if invoice exists; if not, create draft invoice automatically with verified job.company_id
    try {
      const invCheck = await pool.query(`SELECT id FROM invoices WHERE job_id::text = $1::text`, [jobId]);
      if (invCheck.rows.length === 0) {
        const invNum = `INV-${Date.now()}-${String(jobId).substring(0, 8).toUpperCase()}`;
        const totalAmt = Number(job.budget || job.estimated_cost || 0);

        await pool.query(
          `INSERT INTO invoices (company_id, customer_id, job_id, invoice_number, total_amount, status)
           VALUES ($1, $2, $3, $4, $5, 'issued')`,
          [job.company_id, job.customer_id || null, jobId, invNum, totalAmt]
        );
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
