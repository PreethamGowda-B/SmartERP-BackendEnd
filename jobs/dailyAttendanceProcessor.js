const cron = require('node-cron');
const { pool } = require('../db');
const { storage } = require('../middleware/als');
const AttendancePolicy = require('../services/attendancePolicyService');

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
  return storage.run({ isWebRequest: false, bypassRls: true, role: 'system' }, async () => {
    const companies = await pool.query('SELECT id FROM companies ORDER BY id');
    const results = [];
    for (const { id: companyId } of companies.rows) {
      // Company policies currently default to IST. The policy service resolves
      // the work date and due cutoff for that company's timezone.
      const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
      const today = AttendancePolicy.localDate(now, policy.timezone);
      const candidates = [today];
      // Recover the previous work date after a restart, but never rewrite a
      // processed historical row. The task intentionally has no data migration.
      const yesterdayDate = new Date(AttendancePolicy.zonedDateTimeToUtc(today, '12:00', policy.timezone).getTime() - 86400000);
      const yesterday = AttendancePolicy.localDate(yesterdayDate, policy.timezone);
      candidates.unshift(yesterday);
      for (const workDate of candidates) {
        const outcome = await processCompany(companyId, workDate, now);
        results.push({ company_id: companyId, ...outcome });
      }
    }
    console.info('[attendance-processor] completed', JSON.stringify(results));
    return results;
  });
}

function startDailyAttendanceProcessor() {
  cron.schedule('*/5 * * * *', () => {
    runDailyAttendanceProcessing().catch((error) => {
      console.error('[attendance-processor] failed', error.message, error.stack);
    });
  }, { timezone: 'Asia/Kolkata' });

  // Catch up a missed cutoff after process restart. Service-level due checks
  // ensure this never closes today's session before its configured cutoff.
  runDailyAttendanceProcessing().catch((error) => {
    console.error('[attendance-processor] startup recovery failed', error.message, error.stack);
  });
  console.log('✅ Daily attendance processor scheduled (policy cutoff, Asia/Kolkata; 5-minute recovery scan)');
}

module.exports = { startDailyAttendanceProcessor, runDailyAttendanceProcessing, processCompany };
