const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const TARGET_TABLES = [
  // Core tables
  'users',
  'companies',
  'jobs',
  'attendance',
  'payroll',
  'inventory_items',
  'notifications',
  'messages',
  'job_messages',
  'customers',
  'customer_refresh_tokens',
  'refresh_tokens',
  'employee_profiles',
  'material_requests',
  'employee_documents',
  'subscriptions',
  'subscription_events',
  'activities',
  'feedback',
  'plans',
  // AI feature tables
  'gst_reconciliation_runs',
  'gst_reconciliation_items',
  'gst_vendor_compliance',
  'gst_company_settings',
  'inventory_suppliers',
  'inventory_forecasts',
  'inventory_purchase_orders',
  'inventory_po_items',
  'ar_company_policies',
  'ar_collection_schedules',
  'ar_collection_logs',
  'payroll_validation_runs',
  'payroll_validation_flags',
  'crm_leads_enhanced',
  'crm_lead_activities'
];

async function generateNeonSnapshot() {
  const client = await pool.connect();
  const snapshot = {
    timestamp: new Date().toISOString(),
    database_host: 'Neon PostgreSQL (Production)',
    total_tables_checked: TARGET_TABLES.length,
    table_counts: {}
  };

  try {
    console.log('🔍 Querying row counts for all 35 Neon database tables...\n');
    for (const table of TARGET_TABLES) {
      try {
        const res = await client.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
        const count = res.rows[0].count;
        snapshot.table_counts[table] = count;
        console.log(`  ✓ ${table.padEnd(30, ' ')} : ${count} rows`);
      } catch (err) {
        if (err.code === '42P01') {
          // Table doesn't exist yet
          snapshot.table_counts[table] = 0;
          console.log(`  ⚠ ${table.padEnd(30, ' ')} : 0 rows (table does not exist in schema)`);
        } else {
          console.error(`  ❌ Error querying ${table}:`, err.message);
          snapshot.table_counts[table] = null;
        }
      }
    }

    const backupDir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const outputPath = path.join(backupDir, 'migration_checklist_neon.json');
    fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`\n✅ Snapshot saved cleanly to ${outputPath}`);
  } finally {
    client.release();
    process.exit(0);
  }
}

generateNeonSnapshot().catch((err) => {
  console.error('❌ Failed to generate Neon snapshot:', err);
  process.exit(1);
});
