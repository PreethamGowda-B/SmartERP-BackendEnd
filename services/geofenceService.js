/**
 * services/geofenceService.js
 *
 * Geofenced Arrival System
 *
 * Hardening (Sections 4, 11):
 *   - Only tracks jobs where employee_status = 'accepted' (Section 4)
 *   - Stops tracking when employee_status = 'arrived' OR status = 'completed' (Section 4)
 *   - Poll interval: 12 seconds — not continuous (Section 4)
 *   - Idempotent arrival update (arrived_at IS NULL guard)
 *   - Full try/catch — one bad row never stops the batch (Section 11)
 *   - _running guard prevents overlapping evaluation passes
 */

'use strict';

const { pool } = require('../db');
const redisClient = require('../utils/redis');
const { createNotification } = require('../utils/notificationHelpers');
const auditService = require('./auditService');

const GEOFENCE_RADIUS_M = 100;   // 100 metres
const POLL_INTERVAL_MS  = 12_000; // 12 seconds

let _timer = null;
let _running = false;

// ─── Haversine distance in metres ────────────────────────────────────────────
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6_371_000; // Earth radius in metres
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Single evaluation pass ───────────────────────────────────────────────────
async function evaluateGeofences() {
  if (_running) return; // Prevent overlapping runs
  _running = true;

  try {
    // Section 4: Only fetch jobs where:
    //   - employee_status = 'accepted' (not 'arrived', not 'assigned')
    //   - arrived_at IS NULL (stop tracking once arrived)
    //   - status NOT IN ('completed', 'cancelled') (stop tracking finished jobs)
    //   - job has location coordinates
    //   - employee has a recent location (within last 5 minutes)
    const result = await pool.query(
      `SELECT
         j.id          AS job_id,
         j.company_id,
         j.customer_id,
         j.title,
         j.assigned_to AS employee_id,
         j.job_latitude,
         j.job_longitude,
         ep.latitude   AS emp_latitude,
         ep.longitude  AS emp_longitude,
         ep.location_updated_at,
         u.name        AS employee_name
       FROM jobs j
       JOIN employee_profiles ep ON ep.user_id = j.assigned_to
       JOIN users u ON u.id = j.assigned_to
       WHERE j.approval_status = 'approved'
         AND j.assigned_to IS NOT NULL
         AND j.employee_status = 'accepted'
         AND j.arrived_at IS NULL
         AND j.status NOT IN ('completed', 'cancelled')
         AND j.job_latitude IS NOT NULL
         AND j.job_longitude IS NOT NULL
         AND ep.latitude IS NOT NULL
         AND ep.longitude IS NOT NULL
         AND ep.location_updated_at > NOW() - INTERVAL '5 minutes'`
    );

    for (const row of result.rows) {
      try {
        const distM = haversineMetres(
          parseFloat(row.job_latitude),
          parseFloat(row.job_longitude),
          parseFloat(row.emp_latitude),
          parseFloat(row.emp_longitude)
        );

        if (distM <= GEOFENCE_RADIUS_M) {
          await handleArrival(row);
        }
      } catch (rowErr) {
        // Section 11: one bad row never stops the batch
        console.error(`Geofence row error for job ${row.job_id}:`, rowErr.message);
      }
    }
  } catch (err) {
    console.error('Geofence evaluation error:', err.message);
  } finally {
    _running = false;
  }
}

// ─── Handle arrival event ─────────────────────────────────────────────────────
async function handleArrival(row) {
  const { job_id, company_id, customer_id, title, employee_id, employee_name } = row;

  try {
    // Idempotent update — only fires if arrived_at is still NULL
    const updateResult = await pool.query(
      `UPDATE jobs
       SET employee_status = 'arrived',
           arrived_at      = NOW()
       WHERE id = $1
         AND arrived_at IS NULL
       RETURNING id`,
      [job_id]
    );

    if (updateResult.rowCount === 0) {
      return; // Already marked arrived by a concurrent process
    }

    console.log(`📍 Geofence: Employee ${employee_name} arrived at job ${job_id}`);

    // Notify customer via Redis SSE (non-blocking)
    if (customer_id && redisClient && redisClient.status === 'ready') {
      redisClient.publish(
        `customer_job_events:${job_id}`,
        JSON.stringify({
          type: 'employee_arrived',
          jobId: job_id,
          employeeName: employee_name,
          arrivedAt: new Date().toISOString(),
        })
      ).catch((e) => console.error('Geofence SSE publish error:', e.message));
    }

    // Audit log (non-blocking)
    auditService.log({
      companyId: company_id,
      userId: employee_id,
      actorType: 'system',
      actionType: 'employee_arrived',
      entityType: 'job',
      entityId: job_id,
      newValue: { employee_name, arrived_at: new Date().toISOString() },
    }).catch(() => {});
  } catch (err) {
    console.error(`Geofence handleArrival error for job ${job_id}:`, err.message);
  }
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────
function start() {
  if (_timer) return; // Already running
  console.log(`📍 Geofence service started (interval: ${POLL_INTERVAL_MS / 1000}s)`);
  _timer = setInterval(evaluateGeofences, POLL_INTERVAL_MS);
  // Run immediately on start
  evaluateGeofences();
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('📍 Geofence service stopped');
  }
}

module.exports = { start, stop, evaluateGeofences };
