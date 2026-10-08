'use strict';

const { pool } = require('../db');

async function runMigration016() {
  const client = await pool.connect();
  try {
    console.log('--- Running Migration 016: Direct & Walk-in Invoices ---');
    await client.query('BEGIN');

    // 1. Allow job_id to be NULL for direct walk-in counter sales
    await client.query(`
      ALTER TABLE invoices ALTER COLUMN job_id DROP NOT NULL;
    `);
    console.log('✔ Dropped NOT NULL on invoices.job_id');

    // 2. Add invoice_type, customer_address, customer_gstin
    await client.query(`
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_type VARCHAR(50) DEFAULT 'job';
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_address TEXT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_gstin VARCHAR(50);
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
    `);
    console.log('✔ Added invoice_type, customer_address, customer_gstin, payment_method columns');

    // 3. Index for invoice_type and walk-in queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(company_id, invoice_type);
    `);
    console.log('✔ Created index idx_invoices_type');

    await client.query('COMMIT');
    console.log('--- Migration 016 Complete Successfully! ---');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 016 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

runMigration016();
