const express = require("express");
const router = express.Router({ mergeParams: true });
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { authenticateToken } = require("../middleware/authMiddleware");
const { requireClockIn } = require("../middleware/attendanceGatekeeperMiddleware");
const { createNotification, createNotificationForOwners } = require("../utils/notificationHelpers");
const EventMessagingService = require('../services/eventMessagingService');
const { storage } = require('../middleware/als');
const { detectFileSignature } = require('../utils/fileValidation');

const STAFF_ROLES = new Set(['owner', 'admin', 'employee', 'hr', 'manager', 'technician']);

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

// These endpoints accept staff and customer JWTs directly. Install the same
// tenant context as the normal auth middleware before any database queries so
// FORCE ROW LEVEL SECURITY can see the caller's own company rows.
function authenticateProofCaller(req, res, next) {
  const caller = resolveCaller(req);
  if (!caller) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const companyId = caller.companyId || caller.company_id;
  const role = String(caller.role || '').toLowerCase();
  if (!companyId && role !== 'super_admin') {
    return res.status(401).json({ message: 'Authentication is missing company context.' });
  }

  req.proofCaller = caller;
  storage.run({
    isWebRequest: true,
    companyId,
    role,
    userId: caller.id || caller.userId || caller.customerId,
    bypassRls: false,
  }, next);
}

// Ensure proof_of_work table exists in database lazily
let isInitialized = false;
let initializationPromise = null;
async function ensureDbInitialized() {
  if (isInitialized) return;
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE postgres').catch(() => {});
      await client.query(`
      CREATE TABLE IF NOT EXISTS job_proof_of_work (
        id SERIAL PRIMARY KEY,
        job_id TEXT NOT NULL,
        company_id TEXT,
        uploaded_by_id TEXT,
        uploaded_by_name TEXT,
        photo_url TEXT,
        notes TEXT,
        gps_latitude NUMERIC,
        gps_longitude NUMERIC,
        stage TEXT DEFAULT 'in_progress',
        customer_signature_url TEXT,
        client_submission_id TEXT,
        signed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
      await client.query('ALTER TABLE job_proof_of_work ADD COLUMN IF NOT EXISTS client_submission_id TEXT');
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS job_proof_of_work_submission_unique
        ON job_proof_of_work (company_id, client_submission_id)
        WHERE client_submission_id IS NOT NULL`);
      isInitialized = true;
    } finally {
      client.release();
    }
  })();
  try {
    await initializationPromise;
  } catch (error) {
    initializationPromise = null;
    throw error;
  }
}
// ── 1. POST /api/jobs/:id/proof-of-work ─────────────────────────────────────
// Submit site photo, progress notes, and GPS check-in (Field Technicians)
router.post("/:id/proof-of-work", authenticateToken, requireClockIn, async (req, res) => {
  try {
    await ensureDbInitialized();
    const jobId = req.params.id;
    const { photo_url, notes, gps_latitude, gps_longitude, stage = "in_progress", client_submission_id } = req.body;
    const userId = req.user?.userId || req.user?.id;
    const userName = req.user?.name || "Technician";
    const companyId = req.user?.companyId || req.user?.company_id;

    if (!companyId) {
      return res.status(401).json({ message: "Unauthorized: Missing company context." });
    }

    if (!photo_url && !notes) {
      return res.status(400).json({ message: "Photo URL or site notes are required." });
    }
    if (typeof photo_url === 'string') {
      const photoMatch = photo_url.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
      if (!photoMatch) {
        return res.status(400).json({ message: 'Photo must be a valid JPEG, PNG, or WebP image.' });
      }
      const imageBuffer = Buffer.from(photoMatch[2], 'base64');
      const detected = detectFileSignature(imageBuffer);
      if (imageBuffer.length > 5 * 1024 * 1024) {
        return res.status(413).json({ message: 'Compressed site proof images must be 5 MB or smaller.' });
      }
      if (!detected || detected.mime !== photoMatch[1].toLowerCase()) {
        return res.status(400).json({ message: 'Photo file contents do not match the declared image type.' });
      }
    }
    if (typeof notes === 'string' && notes.length > 10000) {
      return res.status(400).json({ message: 'Site notes must be 10,000 characters or fewer.' });
    }
    if (!['in_progress', 'testing', 'completed'].includes(stage)) {
      return res.status(400).json({ message: 'Invalid site proof stage.' });
    }
    if (gps_latitude != null && (!Number.isFinite(Number(gps_latitude)) || Number(gps_latitude) < -90 || Number(gps_latitude) > 90)) {
      return res.status(400).json({ message: 'GPS latitude is invalid.' });
    }
    if (gps_longitude != null && (!Number.isFinite(Number(gps_longitude)) || Number(gps_longitude) < -180 || Number(gps_longitude) > 180)) {
      return res.status(400).json({ message: 'GPS longitude is invalid.' });
    }

    // Verify job belongs to technician's company
    const jobCheck = await pool.query(
      `SELECT id, machine_id, title, company_id, assigned_to, assigned_employee_id, accepted_by FROM jobs WHERE id::text = $1::text AND company_id::text = $2::text`,
      [jobId, String(companyId)]
    );
    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ message: "Job not found." });
    }

    const job = jobCheck.rows[0];
    const role = String(req.user?.role || '').toLowerCase();
    const callerId = String(userId || '');
    const assignedToCaller = [job.assigned_to, job.assigned_employee_id, job.accepted_by]
      .some((id) => id != null && String(id) === callerId);
    if (role === 'employee' && !assignedToCaller) {
      return res.status(403).json({ message: 'Only an employee assigned to this job can submit site proof.' });
    }
    const effectiveCompanyId = job.company_id;
    const submissionId = typeof client_submission_id === 'string' && client_submission_id.length <= 100
      ? client_submission_id
      : null;

    const result = await pool.query(
      `INSERT INTO job_proof_of_work 
       (job_id, company_id, uploaded_by_id, uploaded_by_name, photo_url, notes, gps_latitude, gps_longitude, stage, client_submission_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (company_id, client_submission_id) WHERE client_submission_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [jobId, effectiveCompanyId, userId, userName, photo_url || null, notes || null, gps_latitude ?? null, gps_longitude ?? null, stage, submissionId]
    );
    const inserted = result.rows[0];
    const persisted = inserted || (submissionId
      ? (await pool.query(
          `SELECT * FROM job_proof_of_work WHERE company_id::text = $1::text AND client_submission_id = $2 LIMIT 1`,
          [String(effectiveCompanyId), submissionId],
        )).rows[0]
      : null);
    if (!persisted || String(persisted.job_id) !== String(jobId)) {
      return res.status(409).json({ message: 'This submission ID was already used for a different job. Please reopen the form and try again.' });
    }

    // Read back through the same tenant and job keys before sending a success
    // response or creating any notification.
    const verify = await pool.query(
      `SELECT * FROM job_proof_of_work WHERE id = $1 AND job_id::text = $2::text AND company_id::text = $3::text`,
      [persisted.id, String(jobId), String(effectiveCompanyId)],
    );
    if (verify.rows.length !== 1) throw new Error('Saved site proof could not be read back.');
    const savedProof = verify.rows[0];
    if (!inserted) {
      return res.status(200).json({ success: true, message: "This site proof was already submitted.", proof: savedProof, duplicate: true });
    }

    // Optionally update job status if stage indicates completion or in-progress
    if (inserted && stage === 'completed') {
      await pool.query(
        `UPDATE jobs SET status = 'completed', progress = 100, updated_at = NOW() WHERE id::text = $1::text`,
        [jobId]
      ).catch(() => {});
    } else if (inserted && stage === 'in_progress') {
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
        data: { job_id: jobId, proof_id: savedProof.id, url: `/owner/jobs/${jobId}` }
      });
    } catch (nErr) {
      console.warn('⚠️ Proof of work notification warning:', nErr.message);
    }

    // Auto-Trigger Timeline Event on Machine
    try {
      if (job.machine_id) {
        await pool.query(
          `INSERT INTO machine_timeline_events (company_id, machine_id, job_id, event_type, title, description, created_at)
           VALUES ($1, $2, $3, 'proof_submitted', 'Site Proof & Progress Uploaded', $4, NOW())`,
          [effectiveCompanyId, job.machine_id, jobId, `Engineer ${userName} uploaded site proof for job ${job.title}. Notes: ${notes || 'No notes'}`]
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
      proof: savedProof,
    });
  } catch (err) {
    console.error("❌ Error uploading proof of work:", err);
    return res.status(500).json({ message: "Failed to upload proof of work." });
  }
});

// ── 2. GET /api/jobs/:id/proof-of-work ──────────────────────────────────────
// Fetch complete audit trail of site proof photos, GPS, & signatures
router.get("/:id/proof-of-work", authenticateProofCaller, async (req, res) => {
  try {
    await ensureDbInitialized();
    const caller = req.proofCaller;

    const jobId = req.params.id;

    // Fetch job
    const jobRes = await pool.query(`SELECT * FROM jobs WHERE id::text = $1::text`, [jobId]);
    if (jobRes.rows.length === 0) {
      return res.status(404).json({ message: "Job not found." });
    }

    const job = jobRes.rows[0];
    const callerCompanyId = String(caller.companyId || caller.company_id || '');
    const callerId = String(caller.id || caller.userId || caller.customerId || '');
    const callerRole = String(caller.role || '').toLowerCase();

    // Authorization check
    const isSuperAdmin = callerRole === 'super_admin' || caller.isSuperAdmin;
    const isCompanyStaff = STAFF_ROLES.has(callerRole) && callerCompanyId && callerCompanyId === String(job.company_id);
    const isAssignedTech = callerId && (callerId === String(job.assigned_to) || callerId === String(job.assigned_employee_id));
    const isAuthorizedCustomer = job.customer_id && callerId === String(job.customer_id) && callerCompanyId === String(job.company_id);

    if (!isSuperAdmin && !isCompanyStaff && !(isAssignedTech && callerCompanyId === String(job.company_id)) && !isAuthorizedCustomer) {
      return res.status(403).json({ message: "Access denied: You are not authorized to view proof of work for this job." });
    }

    const result = await pool.query(
      `SELECT * FROM job_proof_of_work WHERE job_id::text = $1::text AND company_id::text = $2::text ORDER BY created_at ASC`,
      [jobId, String(job.company_id)],
    );

    return res.json({
      success: true,
      proofs: result.rows || [],
    });
  } catch (err) {
    console.error("❌ Error fetching proof of work:", err);
    return res.status(500).json({ message: "Failed to fetch proof of work." });
  }
});

// ── 3. POST /api/jobs/:id/customer-signoff ──────────────────────────────────
// Customer E-Signature sign-off approval (Customer Portal & On-site Technician)
router.post("/:id/customer-signoff", authenticateProofCaller, async (req, res) => {
  try {
    const caller = req.proofCaller;

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
    const callerRole = String(caller.role || '').toLowerCase();

    // Authorization: Can be SuperAdmin, Company Staff/Technician on-site collecting sign-off, or the Job Customer
    const isSuperAdmin = callerRole === 'super_admin' || caller.isSuperAdmin;
    const isCompanyStaff = STAFF_ROLES.has(callerRole) && callerCompanyId && callerCompanyId === String(job.company_id);
    const isAssignedTech = callerId && (callerId === String(job.assigned_to) || callerId === String(job.assigned_employee_id));
    const isJobCustomer = job.customer_id && callerId === String(job.customer_id) && callerCompanyId === String(job.company_id);

    if (!isSuperAdmin && !isCompanyStaff && !(isAssignedTech && callerCompanyId === String(job.company_id)) && !isJobCustomer) {
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
