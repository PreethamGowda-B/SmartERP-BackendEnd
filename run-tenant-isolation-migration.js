/**
 * Migration: Add company_id to payroll and employee_profiles tables
 * Needed for strict multi-tenant isolation.
 * Run once: node run-tenant-isolation-migration.js
 */
const { pool } = require('./db');

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('🚀 Starting tenant isolation migration...\n');

    // 1. Add company_id to payroll table
    console.log('📋 Step 1: Adding company_id to payroll table...');
    await client.query(`ALTER TABLE payroll ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payroll_company_id ON payroll(company_id)`);
    console.log('✅ payroll.company_id added\n');

    // 2. Backfill payroll company_id from employee's company
    console.log('📋 Step 2: Backfilling payroll company_id from employee records...');
    const backfillResult = await client.query(`
      UPDATE payroll p
      SET company_id = u.company_id
      FROM users u
      WHERE p.employee_id = u.id
        AND p.company_id IS NULL
        AND u.company_id IS NOT NULL
    `);
    console.log(`✅ Backfilled ${backfillResult.rowCount} payroll records\n`);

    // 3. Add company_id to employee_profiles if missing (for the direct employee creation route)
    console.log('📋 Step 3: Ensuring employee_profiles.company_id exists...');
    await client.query(`ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
    console.log('✅ employee_profiles.company_id ensured\n');

    // 4. Backfill employee_profiles company_id from users table
    console.log('📋 Step 4: Backfilling employee_profiles company_id from users...');
    const epBackfill = await client.query(`
      UPDATE employee_profiles ep
      SET company_id = u.company_id
      FROM users u
      WHERE ep.user_id = u.id
        AND ep.company_id IS NULL
        AND u.company_id IS NOT NULL
    `);
    console.log(`✅ Backfilled ${epBackfill.rowCount} employee_profile records\n`);

    // 5. Verify
    const payrollCount = await client.query('SELECT COUNT(*) as count FROM payroll WHERE company_id IS NOT NULL');
    const payrollTotal = await client.query('SELECT COUNT(*) as count FROM payroll');
    console.log(`📊 Payroll: ${payrollCount.rows[0].count}/${payrollTotal.rows[0].count} records have company_id`);

    console.log('\n✅ Tenant isolation migration completed successfully!');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    console.error(err.stack);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
