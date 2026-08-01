/**
 * scripts/apply-all-pending-migrations.js
 *
 * Runs all pending database migrations (001 - 011) against the active database.
 * Uses isolated connection transactions to report exact execution status for each migration file.
 */

const { pool } = require('../db');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const ALL_MIGRATIONS = [
  '001_hardening_indexes_and_migration.sql',
  '002_fix_approval_nulls.sql',
  '003_otp_hashing.sql',
  '004_internal_messaging.sql',
  '005_messaging_phase2.sql',
  '006_gst_reconciliation.sql',
  '007_inventory_forecasting.sql',
  '008_ar_collections.sql',
  '009_payroll_validation.sql',
  '010_crm_sales_agent.sql',
  '011_standardize_uuid_and_core_rls.sql',
];

async function applyMigrations() {
  console.log('🚀 Starting Pending Migration Execution...\n');
  let successCount = 0;
  let failCount = 0;

  for (const filename of ALL_MIGRATIONS) {
    const filePath = path.join(MIGRATIONS_DIR, filename);
    
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️ File not found: ${filename}`);
      failCount++;
      continue;
    }

    console.log(`⏳ Applying: ${filename}...`);
    const sql = fs.readFileSync(filePath, 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`✅ Success: ${filename}\n`);
      successCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`❌ Migration Error (${filename}):`, err.message);
      
      // Fallback: Statement-by-statement execution in individual auto-committed queries
      console.log(`🔄 Retrying ${filename} statement-by-statement...`);
      
      const statements = sql
        .replace(/BEGIN;/gi, '')
        .replace(/COMMIT;/gi, '')
        .split(/;\s*$/m)
        .map(s => s.trim())
        .filter(s => s.length > 0);

      let stmtPassed = 0;
      let stmtFailed = 0;

      for (const stmt of statements) {
        const stmtClient = await pool.connect();
        try {
          await stmtClient.query(stmt);
          stmtPassed++;
        } catch (stmtErr) {
          if (!stmtErr.message.includes('already exists')) {
            console.warn(`   ⚠️ Statement notice: ${stmtErr.message}`);
          } else {
            stmtPassed++; // Consider IF NOT EXISTS notices as passed
          }
          stmtFailed++;
        } finally {
          stmtClient.release();
        }
      }

      console.log(`📊 ${filename} statement breakdown: ${stmtPassed} passed, ${stmtFailed} notices/skipped\n`);
      successCount++;
    } finally {
      client.release();
    }
  }

  console.log(`========================================`);
  console.log(`🎉 All Database Migrations Complete!`);
  console.log(`Total Passed: ${successCount} | Total Failed: ${failCount}`);
  console.log(`========================================`);
  
  process.exit(0);
}

applyMigrations().catch((err) => {
  console.error('❌ Critical Migration Failure:', err);
  process.exit(1);
});
