const crypto = require('crypto');
const { pool } = require('../db');
const { storage } = require('../middleware/als');
const { analyzePayroll } = require('./payrollAnomalyEngine');
const { approvalBlockReason } = require('./payrollAuditApproval');

const IDENTIFIER_COLUMNS = new Map([
  ['bank_account_number', 'bank_account'], ['bank_account_no', 'bank_account'], ['account_number', 'bank_account'],
  ['pan_number', 'pan'], ['pan_no', 'pan'], ['pan', 'pan'],
]);

function periodBounds(month, year) {
  const previous = new Date(Date.UTC(year, month - 2, 1));
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    previousMonth: previous.getUTCMonth() + 1,
    previousYear: previous.getUTCFullYear(),
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function fingerprint(sources) {
  return crypto.createHash('sha256').update(JSON.stringify(sources)).digest('hex');
}

async function readSources(client, companyId, month, year) {
  const bounds = periodBounds(month, year);
  const payrollResult = await client.query(
    `SELECT p.id::text AS id, p.company_id::text AS company_id,
            COALESCE(u.id::text, p.employee_id::text) AS employee_id, p.employee_email,
            COALESCE(u.name, p.employee_name, NULLIF(split_part(p.employee_email, '@', 1), '')) AS employee_name,
            u.email, u.is_active, u.phone AS user_phone,
            ep.phone AS profile_phone, ep.is_active AS profile_is_active,
            ep.hire_date,
            p.payroll_month, p.payroll_year, p.base_salary, p.extra_amount,
            p.salary_increment, p.deduction, p.total_salary,
            p.present_days, p.absent_days, p.half_days, p.total_working_hours,
            p.remarks, p.created_at, p.updated_at
       FROM payroll p
       LEFT JOIN users u
         ON u.company_id::text = p.company_id::text
        AND ((p.employee_id IS NOT NULL AND u.id::text = p.employee_id::text)
          OR (p.employee_id IS NULL AND LOWER(TRIM(u.email)) = LOWER(TRIM(p.employee_email))))
       LEFT JOIN employee_profiles ep
         ON ep.user_id::text = u.id::text
       WHERE p.company_id::text = $1::text
         AND p.payroll_month = $2 AND p.payroll_year = $3
       ORDER BY p.employee_id::text NULLS LAST, LOWER(p.employee_email), p.id`,
    [String(companyId), month, year]
  );
  const payroll = payrollResult.rows;

  const employeesResult = await client.query(
    `SELECT u.id::text AS id, u.name, u.email, u.is_active, u.phone AS user_phone, u.created_at,
            ep.phone AS profile_phone, ep.is_active AS profile_is_active, ep.hire_date,
            to_jsonb(ep)->>'status' AS profile_status
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id::text = u.id::text
      WHERE u.company_id::text = $1::text AND LOWER(u.role) NOT IN ('owner', 'super_admin')
      ORDER BY u.id::text`,
    [String(companyId)]
  );
  const employeeMap = new Map(employeesResult.rows.map((row) => [row.id, {
    id: row.id, name: row.name, email: row.email, phone: row.profile_phone || row.user_phone || null,
    is_active: row.is_active, profile_is_active: row.profile_is_active,
    profile_status: row.profile_status, hire_date: row.hire_date,
    created_at: row.created_at, identifiers: [],
  }]));
  const employees = Array.from(employeeMap.values());
  const payrollEmployees = Array.from(new Map(payroll.filter((row) => row.employee_id).map((row) => [row.employee_id, employeeMap.get(row.employee_id)]).filter(([, employee]) => Boolean(employee))).values());

  const columnsResult = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('users', 'employee_profiles', 'attendance')
      ORDER BY table_name, column_name`
  );
  const existingColumns = new Set(columnsResult.rows.map((row) => `${row.table_name}.${row.column_name}`));
  const identifierSources = [];
  for (const [column, type] of IDENTIFIER_COLUMNS) {
    for (const table of ['users', 'employee_profiles']) {
      if (existingColumns.has(`${table}.${column}`)) identifierSources.push({ table, column, type });
    }
  }
  for (const source of identifierSources) {
    // Identifiers are used only in memory for normalized equality and are never logged or returned.
    const alias = source.table === 'users' ? 'u' : 'ep';
    const idQuery = source.table === 'users'
      ? `SELECT id::text AS user_id, ${alias}.${source.column}::text AS value FROM users ${alias} WHERE company_id::text = $1::text AND id::text = ANY($2::text[])`
      : `SELECT ${alias}.user_id::text AS user_id, ${alias}.${source.column}::text AS value FROM employee_profiles ${alias} JOIN users scoped_user ON scoped_user.id::text = ${alias}.user_id::text AND scoped_user.company_id::text = $1::text WHERE ${alias}.user_id::text = ANY($2::text[])`;
    const identifierResult = await client.query(idQuery, [String(companyId), employees.map((employee) => employee.id)]);
    for (const item of identifierResult.rows) {
      const employee = employeeMap.get(item.user_id);
      if (employee && item.value) employee.identifiers.push({ type: source.type, value: item.value });
    }
  }

  const ids = payrollEmployees.map((employee) => employee.id);
  let attendance = [];
  let attendanceAvailable = true;
  try {
    if (ids.length) {
      const attendanceDate = existingColumns.has('attendance.date') ? 'date'
        : existingColumns.has('attendance.check_in_time') ? 'COALESCE(check_in_time, created_at)::date'
          : existingColumns.has('attendance.created_at') ? 'created_at::date' : null;
      if (!attendanceDate || !existingColumns.has('attendance.status') || !existingColumns.has('attendance.user_id') || !existingColumns.has('attendance.company_id')) {
        throw Object.assign(new Error('Required attendance date/status/tenant columns are unavailable.'), { code: 'PAYROLL_ATTENDANCE_SCHEMA_UNAVAILABLE' });
      }
      const attendanceResult = await client.query(
        `SELECT user_id::text AS user_id, LOWER(TRIM(status)) AS status, COUNT(*)::int AS count
           FROM attendance
          WHERE company_id::text = $1::text AND user_id::text = ANY($2::text[])
            AND ${attendanceDate} >= $3::date AND ${attendanceDate} < $4::date
          GROUP BY user_id::text, LOWER(TRIM(status))
          ORDER BY user_id::text, LOWER(TRIM(status))`,
        [String(companyId), ids, bounds.start, bounds.end]
      );
      attendance = attendanceResult.rows.flatMap((row) => Array.from({ length: row.count }, () => ({ user_id: row.user_id, status: row.status })));
    }
  } catch (error) {
    attendanceAvailable = false;
    console.warn('Payroll audit attendance source unavailable:', error.code || 'query_error');
  }

  let previousPayroll = [];
  if (ids.length) {
    const emails = employees.map((employee) => String(employee.email || '').trim().toLowerCase()).filter(Boolean);
    const previousResult = await client.query(
      `SELECT id::text AS id, employee_id::text AS employee_id, LOWER(TRIM(employee_email)) AS employee_email,
              base_salary, extra_amount, salary_increment, total_salary,
              payroll_month, payroll_year
         FROM payroll
        WHERE company_id::text = $1::text AND payroll_month = $2 AND payroll_year = $3
          AND (employee_id::text = ANY($4::text[]) OR LOWER(TRIM(employee_email)) = ANY($5::text[]))
        ORDER BY employee_id::text NULLS LAST, LOWER(TRIM(employee_email)), created_at DESC, id DESC`,
      [String(companyId), bounds.previousMonth, bounds.previousYear, ids, emails]
    );
    previousPayroll = previousResult.rows;
  }

  let exits = [];
  let exitSourceAvailable = true;
  try {
    if (ids.length) {
      const exitResult = await client.query(
        `SELECT user_id::text AS user_id, status, fnf_amount
           FROM hr_exit_management
          WHERE company_id::text = $1::text AND user_id::text = ANY($2::text[])
          ORDER BY created_at DESC, id DESC`,
        [String(companyId), ids]
      );
      exits = exitResult.rows;
    }
  } catch (error) {
    if (error.code === '42P01' || error.code === '42703') {
      exitSourceAvailable = false;
      console.warn('Payroll audit final-settlement source unavailable:', error.code);
    } else {
      throw error;
    }
  }

  const bankOrPanAvailable = identifierSources.length > 0;
  const sourceSnapshot = { payroll, employees, attendance, attendanceAvailable, previousPayroll, exits,
    exitSourceAvailable, bankOrPanAvailable, identifierSources: identifierSources.map(({ table, column, type }) => ({ table, column, type })) };
  return { payroll, employees, attendance, attendanceAvailable, previousPayroll, exits, exitSourceAvailable,
    bankOrPanAvailable, sourceSnapshot, fingerprint: fingerprint(sourceSnapshot) };
}

class PayrollValidationService {
  static async runPreRunValidation({ companyId, userId, month, year }) {
    return storage.run({ companyId: String(companyId), role: 'owner' }, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query(`SELECT set_config('app.current_company_id', $1::text, true)`, [String(companyId)]);
        const sources = await readSources(client, companyId, month, year);
        const analysis = analyzePayroll({
          ...sources,
          capabilities: { bankOrPan: sources.bankOrPanAvailable },
          period: { month, year },
        });
        const databaseStatus = analysis.overallStatus === 'passed' ? 'completed' : analysis.overallStatus;
        const runResult = await client.query(
          `INSERT INTO payroll_validation_runs
             (company_id, created_by, month, year, status, total_employees_checked,
              total_anomalies_found, risk_level, audit_status, record_count,
              checks_executed, check_results, payroll_fingerprint, source_updated_at,
              is_approved, created_at, updated_at)
           VALUES ($1::text, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, NOW(), FALSE, NOW(), NOW())
           RETURNING *`,
          [String(companyId), userId, month, year, databaseStatus,
            new Set(sources.payroll.map((row) => row.employee_id || String(row.employee_email || '').trim().toLowerCase()).filter(Boolean)).size,
            analysis.totalAnomalies, analysis.riskLevel, analysis.overallStatus,
            analysis.recordCount, analysis.checksExecuted, JSON.stringify(analysis.checks), sources.fingerprint]
        );
        const run = runResult.rows[0];
        for (const finding of analysis.findings) {
          await client.query(
            `INSERT INTO payroll_validation_flags
               (validation_run_id, company_id, user_id, employee_name, flag_type, severity,
                description, is_resolved, source_table, source_record_id, finding_details, created_at)
             VALUES ($1, $2::text, $3, $4, $5, $6, $7, FALSE, $8, $9, $10::jsonb, NOW())`,
            [run.id, String(companyId), finding.user_id, finding.employee_name, finding.flag_type,
              finding.severity, finding.description, finding.source_table, finding.source_record_id,
              JSON.stringify(finding.details)]
          );
        }
        await client.query('COMMIT');
        return {
          success: true,
          runId: run.id,
          riskLevel: analysis.riskLevel,
          auditStatus: analysis.overallStatus,
          recordCount: analysis.recordCount,
          checksExecuted: analysis.checksExecuted,
          totalAnomalies: analysis.totalAnomalies,
          checks: analysis.checks,
          isFuturePeriod: analysis.isFuturePeriod,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    });
  }

  static async getRunDetails({ companyId, runId }) {
    return storage.run({ companyId: String(companyId), role: 'owner' }, async () => {
      const runResult = await pool.query(
        `SELECT * FROM payroll_validation_runs WHERE id::text = $1::text AND company_id::text = $2::text`,
        [runId, String(companyId)]
      );
      if (!runResult.rows.length) return null;
      const run = runResult.rows[0];
      const flagResult = await pool.query(
        `SELECT id::text, validation_run_id::text, company_id::text, user_id::text,
                employee_name, flag_type, severity, description, ai_analysis_reasoning,
                is_resolved, resolution_notes, created_at, source_table,
                source_record_id, finding_details
           FROM payroll_validation_flags
          WHERE validation_run_id::text = $1::text AND company_id::text = $2::text
          ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC`,
        [runId, String(companyId)]
      );
      const sources = await readSources(pool, companyId, Number(run.month), Number(run.year));
      return {
        run: { ...run, is_stale: run.payroll_fingerprint !== sources.fingerprint },
        flags: flagResult.rows,
      };
    });
  }

  static async resolveFlag({ companyId, userId, flagId, resolutionNotes }) {
    const result = await pool.query(
      `UPDATE payroll_validation_flags
          SET is_resolved = TRUE, resolution_notes = $1, resolved_by = $2, resolved_at = NOW()
        WHERE id::text = $3::text AND company_id::text = $4::text
        RETURNING *`,
      [resolutionNotes || 'Reviewed by owner.', userId, flagId, String(companyId)]
    );
    return result.rows[0] || null;
  }

  static async approveRun({ companyId, userId, runId }) {
    return storage.run({ companyId: String(companyId), role: 'owner' }, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query(`SELECT set_config('app.current_company_id', $1::text, true)`, [String(companyId)]);
        const runResult = await client.query(
          `SELECT * FROM payroll_validation_runs WHERE id::text = $1::text AND company_id::text = $2::text FOR UPDATE`,
          [runId, String(companyId)]
        );
        const run = runResult.rows[0];
        if (!run) throw Object.assign(new Error('Audit run not found for this company.'), { statusCode: 404 });
        const current = await readSources(client, companyId, Number(run.month), Number(run.year));
        const unresolved = await client.query(
          `SELECT COUNT(*)::int AS count FROM payroll_validation_flags
            WHERE validation_run_id::text = $1::text AND company_id::text = $2::text
              AND severity = 'critical' AND is_resolved = FALSE`,
          [runId, String(companyId)]
        );
        const blockReason = approvalBlockReason({
          ...run,
          is_stale: run.payroll_fingerprint !== current.fingerprint,
          unresolved_critical_count: unresolved.rows[0].count,
        });
        if (blockReason) throw Object.assign(new Error(`Approval blocked: ${blockReason}`), { statusCode: 409 });
        const updated = await client.query(
          `UPDATE payroll_validation_runs SET is_approved = TRUE, approved_by = $1,
                  approved_at = NOW(), updated_at = NOW()
            WHERE id::text = $2::text AND company_id::text = $3::text RETURNING *`,
          [userId, runId, String(companyId)]
        );
        await client.query('COMMIT');
        return updated.rows[0];
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    });
  }
}

module.exports = PayrollValidationService;
module.exports.readSources = readSources;
module.exports.fingerprint = fingerprint;
