const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  logAttendanceProcessorCompletion,
  logAttendanceProcessorFailure,
} = require('../services/attendanceProcessorLogger');

function captureLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    calls,
    info: (...args) => calls.info.push(args),
    warn: (...args) => calls.warn.push(args),
    error: (...args) => calls.error.push(args),
  };
}

test('routine processor run logs one concise aggregate and no per-company warnings', () => {
  const logger = captureLogger();
  const summary = logAttendanceProcessorCompletion([
    { company_id: 12, date: '2026-10-19', auto_clocked_out: 0, marked_absent: 0, records_locked: 0, duplicate_records: 0, invalid_time_ranges: 0 },
    { company_id: 12, date: '2026-10-20', auto_clocked_out: 0, marked_absent: 0, records_locked: 0 },
    { company_id: 34, date: '2026-10-19', auto_clocked_out: 0, marked_absent: 0, records_locked: 0 },
  ], 120, logger);

  assert.deepEqual(summary, {
    companies: 2,
    auto_clocked_out: 0,
    marked_absent: 0,
    records_locked: 0,
    errors: 0,
    duration_ms: 120,
  });
  assert.equal(logger.calls.info.length, 1);
  assert.equal(logger.calls.warn.length, 0);
  assert.equal(logger.calls.info[0][0], '[attendance-processor] completed companies=2 auto_clocked_out=0 marked_absent=0 records_locked=0 errors=0 duration_ms=120');
});

test('anomalies produce company/date warnings without dumping result details', () => {
  const logger = captureLogger();
  logAttendanceProcessorCompletion([{
    company_id: 12,
    date: '2026-10-20',
    auto_clocked_out: 0,
    marked_absent: 0,
    records_locked: 0,
    duplicate_records: 2,
    invalid_time_ranges: 1,
    employee_name: 'must not be logged',
  }], 7, logger);

  assert.equal(logger.calls.warn.length, 1);
  assert.equal(logger.calls.warn[0][0], '[attendance-processor] anomaly company_id=12 work_date=2026-10-20 duplicate_records=2 invalid_time_ranges=1');
  assert.equal(logger.calls.warn[0].join(' ').includes('must not be logged'), false);
  assert.equal(logger.calls.info.length, 1);
});

test('processor failures remain visible with company and work-date context', () => {
  const logger = captureLogger();
  const error = new Error('database operation failed');
  error.attendanceProcessorContext = { companyId: 12, workDate: '2026-10-20' };

  logAttendanceProcessorFailure(error, logger);

  assert.equal(logger.calls.error.length, 1);
  assert.equal(logger.calls.error[0][0], '[attendance-processor] failed company_id=12 work_date=2026-10-20');
  assert.equal(logger.calls.error[0][1], 'database operation failed');
  assert.equal(logger.calls.error[0][2], error.stack);
});
