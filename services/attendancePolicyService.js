const DEFAULT_ATTENDANCE_POLICY = Object.freeze({
  timezone: 'Asia/Kolkata',
  shiftStart: '09:00',
  shiftEnd: '19:00',
  earliestClockIn: '09:00',
  lateThreshold: '09:00',
  gracePeriodMinutes: 0,
  halfDayThreshold: '13:00',
  clockInCutoff: '11:00',
  automaticClockOutEnabled: true,
  automaticClockOutTime: '19:00',
  earlyDepartureIsHalfDay: true,
  workingHoursRounding: 2,
});

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const POLICY_KEY = 'attendance_policy';

function validatePolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Attendance policy must be an object');
  const allowed = new Set(Object.keys(DEFAULT_ATTENDANCE_POLICY));
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown attendance policy field(s): ${unknown.join(', ')}`);
  const policy = { ...DEFAULT_ATTENDANCE_POLICY, ...input };
  try { new Intl.DateTimeFormat('en', { timeZone: policy.timezone }); }
  catch { throw new Error('Invalid attendance timezone'); }
  if (policy.timezone !== DEFAULT_ATTENDANCE_POLICY.timezone) throw new Error('Attendance timezone is fixed to Asia/Kolkata for this release');
  for (const key of ['shiftStart', 'shiftEnd', 'earliestClockIn', 'lateThreshold', 'halfDayThreshold', 'clockInCutoff', 'automaticClockOutTime']) {
    if (!TIME_RE.test(policy[key])) throw new Error(`Invalid time for ${key}; expected HH:mm`);
  }
  if (!Number.isInteger(policy.gracePeriodMinutes) || policy.gracePeriodMinutes < 0 || policy.gracePeriodMinutes > 180) throw new Error('gracePeriodMinutes must be between 0 and 180');
  if (![0, 1, 2].includes(policy.workingHoursRounding)) throw new Error('workingHoursRounding must be 0, 1, or 2');
  for (const key of ['automaticClockOutEnabled', 'earlyDepartureIsHalfDay']) if (typeof policy[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  const minute = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  if (minute(policy.shiftStart) >= minute(policy.shiftEnd)) throw new Error('Overnight shifts are not supported');
  if (minute(policy.earliestClockIn) > minute(policy.shiftStart)) throw new Error('earliestClockIn must be at or before shiftStart');
  if (minute(policy.clockInCutoff) < minute(policy.earliestClockIn)) throw new Error('clockInCutoff must not be before earliestClockIn');
  if (minute(policy.automaticClockOutTime) < minute(policy.shiftStart)) throw new Error('automaticClockOutTime must be after shiftStart');
  return policy;
}

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(date));
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}

function localDate(date = new Date(), timezone = DEFAULT_ATTENDANCE_POLICY.timezone) {
  const p = localParts(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

function localTime(date, timezone = DEFAULT_ATTENDANCE_POLICY.timezone) {
  const p = localParts(date, timezone);
  return `${p.hour}:${p.minute}`;
}

function localMillisecondsOfDay(date, timezone = DEFAULT_ATTENDANCE_POLICY.timezone) {
  const p = localParts(date, timezone);
  return Number(p.hour) * 3600000 + Number(p.minute) * 60000 + Number(p.second) * 1000 + new Date(date).getMilliseconds();
}

function zonedDateTimeToUtc(dateText, timeText, timezone = DEFAULT_ATTENDANCE_POLICY.timezone) {
  const [year, month, day] = dateText.split('-').map(Number);
  const [hour, minute] = timeText.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = desired;
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(new Date(candidate), timezone);
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    candidate += desired - represented;
  }
  return new Date(candidate);
}

function calculateWorkingHours(checkIn, checkOut, policyInput = DEFAULT_ATTENDANCE_POLICY) {
  const policy = validatePolicy(policyInput);
  const elapsedMs = new Date(checkOut).getTime() - new Date(checkIn).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid attendance time range');
  const grossHours = elapsedMs / 3600000;
  const factor = 10 ** policy.workingHoursRounding;
  return Math.round((grossHours + Number.EPSILON) * factor) / factor;
}

function isLate(checkIn, policyInput = DEFAULT_ATTENDANCE_POLICY) {
  const policy = validatePolicy(policyInput);
  const thresholdMs = (Number(policy.lateThreshold.slice(0, 2)) * 60 + Number(policy.lateThreshold.slice(3)) + policy.gracePeriodMinutes) * 60000;
  return localMillisecondsOfDay(checkIn, policy.timezone) > thresholdMs;
}

function classifyStatus(checkIn, checkOut, policyInput = DEFAULT_ATTENDANCE_POLICY) {
  const policy = validatePolicy(policyInput);
  if (!checkIn) return 'absent';
  if (localTime(checkIn, policy.timezone) >= policy.halfDayThreshold) return 'half_day';
  if (checkOut && policy.earlyDepartureIsHalfDay && localTime(checkOut, policy.timezone) < policy.shiftEnd) return 'half_day';
  return isLate(checkIn, policy) ? 'late' : 'present';
}

function evaluateClockIn(now, policyInput = DEFAULT_ATTENDANCE_POLICY) {
  const policy = validatePolicy(policyInput);
  const toMilliseconds = (v) => (Number(v.slice(0, 2)) * 60 + Number(v.slice(3))) * 60000;
  const current = localMillisecondsOfDay(now, policy.timezone);
  if (current < toMilliseconds(policy.earliestClockIn)) return { allowed: false, code: 'too_early', reason: `Clock-in opens at ${policy.earliestClockIn}` };
  if (current > toMilliseconds(policy.clockInCutoff)) return { allowed: false, code: 'cutoff_passed', reason: `Clock-in closed at ${policy.clockInCutoff}` };
  return { allowed: true, code: null, reason: null, is_late: isLate(now, policy), status: classifyStatus(now, null, policy) };
}

function automaticClockOutFor(workDate, at = new Date(), policyInput = DEFAULT_ATTENDANCE_POLICY) {
  const policy = validatePolicy(policyInput);
  const cutoff = zonedDateTimeToUtc(workDate, policy.automaticClockOutTime, policy.timezone);
  const cutoffReached = new Date(at).getTime() >= cutoff.getTime();
  return { cutoff, cutoffReached, due: policy.automaticClockOutEnabled && cutoffReached };
}

async function getCompanyPolicy(companyId, queryable) {
  return (await getCompanyPolicyEntry(companyId, queryable)).policy;
}

async function getCompanyPolicyEntry(companyId, queryable) {
  if (!companyId) throw new Error('Missing company affiliation');
  const result = await queryable.query('SELECT setting_value, updated_at FROM company_settings WHERE company_id = $1 AND setting_key = $2 LIMIT 1', [String(companyId), POLICY_KEY]);
  if (!result.rows.length || !result.rows[0].setting_value) return { policy: validatePolicy(), updatedAt: null };
  let parsed;
  try { parsed = JSON.parse(result.rows[0].setting_value); }
  catch { throw new Error('Stored attendance policy is invalid JSON'); }
  return { policy: validatePolicy(parsed), updatedAt: result.rows[0].updated_at || null };
}

async function saveCompanyPolicy(companyId, updatedBy, input, queryable) {
  if (!companyId) throw new Error('Missing company affiliation');
  const policy = validatePolicy(input);
  await queryable.query(
    `INSERT INTO company_settings (company_id, setting_key, setting_value, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (company_id, setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [String(companyId), POLICY_KEY, JSON.stringify(policy), updatedBy || null],
  );
  return policy;
}

function lockKey(userId, companyId, workDate) { return `attendance:${companyId}:${userId}:${workDate}`; }
function policyLockKey(companyId, workDate) { return `attendance-policy:${companyId}:${workDate}`; }

async function processCompanyDate(companyId, workDate, queryable, now = new Date()) {
  await queryable.query('SELECT pg_advisory_xact_lock(hashtext($1))', [policyLockKey(companyId, workDate)]);
  const policyEntry = await getCompanyPolicyEntry(companyId, queryable);
  const policy = policyEntry.policy;
  const currentDate = localDate(now, policy.timezone);
  if (workDate < currentDate && policyEntry.updatedAt && localDate(policyEntry.updatedAt, policy.timezone) > workDate) {
    return { date: workDate, due: false, policy_changed: true, auto_clocked_out: 0, marked_absent: 0, records_locked: 0, duplicate_records: 0 };
  }
  const { cutoff, cutoffReached } = automaticClockOutFor(workDate, now, policy);
  if (!cutoffReached) {
    return { date: workDate, due: false, auto_clocked_out: 0, marked_absent: 0, records_locked: 0 };
  }
  const employees = await queryable.query("SELECT id FROM users WHERE role = 'employee' AND company_id::text = $1::text ORDER BY id", [String(companyId)]);
  const counts = { date: workDate, due: true, auto_clocked_out: 0, marked_absent: 0, records_locked: 0, duplicate_records: 0, invalid_time_ranges: 0 };
  for (const employee of employees.rows) {
    const userId = employee.id;
    await queryable.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(userId, companyId, workDate)]);
    const found = await queryable.query('SELECT * FROM attendance WHERE user_id = $1 AND company_id::text = $2::text AND date = $3 ORDER BY created_at ASC FOR UPDATE', [userId, String(companyId), workDate]);
    if (found.rows.length > 1) {
      counts.duplicate_records += found.rows.length;
      continue;
    }
    let record = found.rows[0];
    if (record?.check_in_time && !record.check_out_time && !policy.automaticClockOutEnabled) continue;
    if (record?.check_in_time && !record.check_out_time && !record.is_processed && policy.automaticClockOutEnabled) {
      const checkInMs = new Date(record.check_in_time).getTime();
      if (!Number.isFinite(checkInMs) || checkInMs > cutoff.getTime()) {
        counts.invalid_time_ranges += 1;
        continue;
      }
      const hours = calculateWorkingHours(record.check_in_time, cutoff, policy);
      const status = classifyStatus(record.check_in_time, cutoff, policy);
      const updated = await queryable.query(`UPDATE attendance SET check_out_time = $1, working_hours = $2, status = $3, is_auto_clocked_out = TRUE, clock_out_method = 'automatic', updated_at = NOW() WHERE id = $4 AND company_id::text = $5::text AND check_out_time IS NULL RETURNING id`, [cutoff, hours, status, record.id, String(companyId)]);
      counts.auto_clocked_out += updated.rows.length;
    } else {
      const leave = await queryable.query(
        `SELECT 1 FROM hr_employee_requests
         WHERE company_id::text = $1::text AND user_id::text = $2::text AND request_type = 'leave' AND status = 'approved'
           AND COALESCE(details->>'start_date', details->>'from_date') <= $3
           AND COALESCE(details->>'end_date', details->>'to_date') >= $3
         LIMIT 1`,
        [String(companyId), String(userId), workDate],
      );
      if (leave.rows.length && record?.status === 'absent' && workDate === currentDate) {
        // Approval may arrive after today's absence row was processed. Correct
        // only the current work date; never rewrite a historical attendance row.
        const updated = await queryable.query(
          `UPDATE attendance SET status = 'leave', updated_at = NOW()
           WHERE id = $1 AND company_id::text = $2::text AND date = $3 AND status = 'absent'
           RETURNING id, status, is_processed`,
          [record.id, String(companyId), workDate]
        );
        if (updated.rows.length) record = { ...record, ...updated.rows[0] };
      } else if (!record && !leave.rows.length) {
        const inserted = await queryable.query(`INSERT INTO attendance (user_id, company_id, date, status, is_processed, created_at, updated_at) VALUES ($1, $2, $3, 'absent', FALSE, NOW(), NOW()) RETURNING id`, [userId, companyId, workDate]);
        counts.marked_absent += inserted.rows.length;
        record = inserted.rows[0];
      }
    }
    if (record?.id && !record.is_processed) {
      const locked = await queryable.query('UPDATE attendance SET is_processed = TRUE, processed_at = NOW() WHERE id = $1 AND company_id::text = $2::text AND is_processed = FALSE RETURNING id', [record.id, String(companyId)]);
      counts.records_locked += locked.rows.length;
    }
  }
  return counts;
}

module.exports = {
  DEFAULT_ATTENDANCE_POLICY,
  POLICY_KEY,
  validatePolicy,
  localDate,
  localTime,
  localMillisecondsOfDay,
  zonedDateTimeToUtc,
  calculateWorkingHours,
  isLate,
  classifyStatus,
  evaluateClockIn,
  automaticClockOutFor,
  getCompanyPolicy,
  getCompanyPolicyEntry,
  saveCompanyPolicy,
  lockKey,
  policyLockKey,
  processCompanyDate,
};
