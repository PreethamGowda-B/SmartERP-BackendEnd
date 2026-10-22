const cron = require('node-cron');
const { pool } = require('../db');
const { storage } = require('../middleware/als');
const AttendancePolicy = require('../services/attendancePolicyService');
const {
  logAttendanceProcessorCompletion,
  logAttendanceProcessorFailure,
} = require('../services/attendanceProcessorLogger');

function attachProcessorErrorContext(error, context) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      error.attendanceProcessorContext = context;
    } catch {
      // Preserve the original failure if its error object cannot be annotated.
    }
  }
}

async function processCompany(companyId, workDate, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`attendance-run:${companyId}:${workDate}`]);
    const result = await AttendancePolicy.processCompanyDate(companyId, workDate, client, now);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runDailyAttendanceProcessing(now = new Date()) {
  const startedAt = Date.now();
  return storage.run({ isWebRequest: false, bypassRls: true, role: 'system' }, async () => {
    const companies = await pool.query('SELECT id FROM companies ORDER BY id');
    const results = [];
    for (const { id: companyId } of companies.rows) {
      // Company policies currently default to IST. The policy service resolves
      // the work date and due cutoff for that company's timezone.
      try {
        const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
        const today = AttendancePolicy.localDate(now, policy.timezone);
        const candidates = [today];
        // Recover the previous work date after a restart, but never rewrite a
        // processed historical row. The task intentionally has no data migration.
        const yesterdayDate = new Date(AttendancePolicy.zonedDateTimeToUtc(today, '12:00', policy.timezone).getTime() - 86400000);
        const yesterday = AttendancePolicy.localDate(yesterdayDate, policy.timezone);
        candidates.unshift(yesterday);
        for (const workDate of candidates) {
          try {
            const outcome = await processCompany(companyId, workDate, now);
            results.push({ company_id: companyId, ...outcome });
          } catch (error) {
            attachProcessorErrorContext(error, { companyId, workDate });
            throw error;
          }
        }
      } catch (error) {
        if (!error?.attendanceProcessorContext) attachProcessorErrorContext(error, { companyId });
        throw error;
      }
    }
    logAttendanceProcessorCompletion(results, Date.now() - startedAt);
    return results;
  });
}

function startDailyAttendanceProcessor() {
  // Tick every minute so a transient process/database failure is retried on
  // the next tick, with startup recovery and transactional idempotency intact.
  cron.schedule('* * * * *', () => {
    runDailyAttendanceProcessing().catch((error) => {
      logAttendanceProcessorFailure(error);
    });
  }, { timezone: 'Asia/Kolkata' });

  // Catch up a missed cutoff after process restart. Service-level due checks
  // ensure this never closes today's session before its configured cutoff.
  runDailyAttendanceProcessing().catch((error) => {
    logAttendanceProcessorFailure(error, console, 'startup recovery failed');
  });
  console.log('✅ Daily attendance processor scheduled (policy cutoff, Asia/Kolkata; 1-minute retry and startup recovery)');
}

module.exports = { startDailyAttendanceProcessor, runDailyAttendanceProcessing, processCompany };
