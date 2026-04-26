/**
 * services/smartDispatch.js
 *
 * Smart Dispatch System — automatically assigns the best available employee
 * to an approved customer job using a composite scoring algorithm.
 *
 * Hardening (Sections 1, 3, 11):
 *   - Assignment wrapped in a DB transaction (assign + increment active_job_count atomically)
 *   - Fallback: if no employee found, job stays open + owner/HR notified
 *   - Full try/catch — never throws, always returns a result object
 *   - Never overrides a manual assignment
 *
 * Scoring factors (weighted):
 *   1. Proximity to job location (40%) — nearest employee scores highest
 *   2. Active job count (35%)          — fewest active jobs scores highest
 *   3. Employee rating (25%)           — highest rating scores highest
 *   + Favorite employee bonus (+0.3)
 */

'use strict';

const { pool } = require('../db');
const { createNotification, createNotificationForOwners } = require('../utils/notificationHelpers');
const auditService = require('./auditService');

// ─── Haversine distance (km) ──────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Main dispatch function ───────────────────────────────────────────────────
/**
 * @param {string} jobId
 * @param {string} companyId
 * @returns {Promise<{assigned: boolean, employeeId: string|null, reason: string}>}
 */
async function dispatchJob(jobId, companyId) {
  try {
    // 1. Fetch the job
    const jobResult = await pool.query(
      `SELECT id, title, priority, approval_status, assigned_to,
              job_latitude, job_longitude, customer_id, company_id
       FROM jobs
       WHERE id = $1 AND company_id = $2`,
      [jobId, companyId]
    );

    if (jobResult.rows.length === 0) {
      return { assigned: false, employeeId: null, reason: 'job_not_found' };
    }

    const job = jobResult.rows[0];

    if (job.approval_status !== 'approved') {
      return { assigned: false, employeeId: null, reason: 'job_not_approved' };
    }

    // Never override a manual assignment
    if (job.assigned_to) {
      return { assigned: false, employeeId: job.assigned_to, reason: 'already_assigned' };
    }

    // 2. Check for favorite employee
    let favoriteEmployeeId = null;
    if (job.customer_id) {
      try {
        const favResult = await pool.query(
          `SELECT cfe.user_id
           FROM customer_favorite_employees cfe
           JOIN users u ON u.id = cfe.user_id
           WHERE cfe.customer_id = $1
             AND cfe.company_id = $2
             AND u.is_active = TRUE
           LIMIT 1`,
          [job.customer_id, companyId]
        );
        if (favResult.rows.length > 0) {
          favoriteEmployeeId = favResult.rows[0].user_id;
        }
      } catch {
        // Non-critical — continue without favorite boost
      }
    }

    // 3. Fetch active employees
    const employeesResult = await pool.query(
      `SELECT
         u.id,
         u.name,
         ep.latitude,
         ep.longitude,
         ep.rating,
         ep.active_job_count,
         ep.is_online
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.company_id = $1
         AND u.role = 'employee'
         AND u.is_active = TRUE`,
      [companyId]
    );

    if (employeesResult.rows.length === 0) {
      await handleNoEmployee(jobId, companyId, job, 'no_employees');
      return { assigned: false, employeeId: null, reason: 'no_employees' };
    }

    // 4. Score employees
    const scored = employeesResult.rows.map((emp) => {
      let proximityScore = 0.5;
      if (job.job_latitude && job.job_longitude && emp.latitude && emp.longitude) {
        const distKm = haversineKm(
          parseFloat(job.job_latitude), parseFloat(job.job_longitude),
          parseFloat(emp.latitude),    parseFloat(emp.longitude)
        );
        proximityScore = Math.max(0, 1 - distKm / 50);
      }

      const activeJobs = emp.active_job_count || 0;
      const availabilityScore = Math.max(0, 1 - activeJobs / 10);

      const rating = parseFloat(emp.rating) || 3.0;
      const ratingScore = rating / 5.0;

      const favoriteBonus = emp.id === favoriteEmployeeId ? 0.3 : 0;

      const composite =
        proximityScore * 0.40 +
        availabilityScore * 0.35 +
        ratingScore * 0.25 +
        favoriteBonus;

      return { ...emp, composite };
    });

    scored.sort((a, b) => b.composite - a.composite);
    const best = scored[0];

    if (!best || best.composite <= 0) {
      await handleNoEmployee(jobId, companyId, job, 'no_suitable_employee');
      return { assigned: false, employeeId: null, reason: 'no_suitable_employee' };
    }

    // 5. Assign atomically in a transaction (Section 1)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE jobs
         SET assigned_to     = $1,
             assigned_at     = NOW(),
             dispatch_status = 'dispatched',
             employee_status = 'assigned'
         WHERE id = $2 AND company_id = $3 AND assigned_to IS NULL`,
        [best.id, jobId, companyId]
      );

      await client.query(
        `UPDATE employee_profiles
         SET active_job_count = COALESCE(active_job_count, 0) + 1
         WHERE user_id = $1`,
        [best.id]
      );

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    // 6. Notify employee (non-blocking)
    createNotification({
      user_id: best.id,
      company_id: companyId,
      type: 'job_assigned',
      title: 'New Job Assigned',
      message: `You have been assigned a new job: ${job.title}`,
      priority: job.priority || 'medium',
      data: { job_id: jobId, job_title: job.title, source: 'smart_dispatch' },
    }).catch((e) => console.error('Dispatch notification error:', e.message));

    // 7. Audit log (non-blocking)
    auditService.log({
      companyId,
      actorType: 'system',
      actionType: 'job_dispatched',
      entityType: 'job',
      entityId: jobId,
      newValue: { assigned_to: best.id, employee_name: best.name, score: best.composite.toFixed(3) },
    }).catch(() => {});

    console.log(`✅ Smart Dispatch: Job ${jobId} → ${best.name} (score: ${best.composite.toFixed(3)})`);
    return { assigned: true, employeeId: best.id, reason: 'dispatched' };

  } catch (err) {
    console.error('Smart Dispatch error:', err.message);
    // Section 3: even on error, don't fail the approval — just mark unassigned
    pool.query(
      `UPDATE jobs SET dispatch_status = 'unassigned' WHERE id = $1 AND company_id = $2`,
      [jobId, companyId]
    ).catch(() => {});
    return { assigned: false, employeeId: null, reason: 'error', error: err.message };
  }
}

// ─── Section 3: Fallback — no employee found ──────────────────────────────────
async function handleNoEmployee(jobId, companyId, job, reason) {
  // Keep job open and unassigned — do NOT fail the approval
  await pool.query(
    `UPDATE jobs
     SET dispatch_status = 'unassigned',
         status          = 'open'
     WHERE id = $1 AND company_id = $2`,
    [jobId, companyId]
  ).catch((e) => console.error('handleNoEmployee update error:', e.message));

  // Notify owner/HR so they can assign manually
  createNotificationForOwners({
    company_id: companyId,
    type: 'dispatch_failed',
    title: 'No Employee Available for Auto-Assignment',
    message: `Job "${job.title}" was approved but no suitable employee could be assigned automatically. Please assign manually.`,
    priority: job.priority || 'medium',
    data: { job_id: jobId, job_title: job.title, reason },
  }).catch((e) => console.error('Dispatch fallback notification error:', e.message));

  console.warn(`⚠️  Smart Dispatch fallback: Job ${jobId} — ${reason}. Owner/HR notified.`);
}

module.exports = { dispatchJob };
