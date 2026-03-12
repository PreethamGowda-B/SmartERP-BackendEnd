/**
 * Run subscription plans migration
 * Usage: node scripts/runSubscriptionMigration.js
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function runMigration() {
  console.log('🚀 Running subscription migration...');
  const sql = fs.readFileSync(
    path.join(__dirname, '../migrations/subscriptionPlans.sql'),
    'utf8'
  );

  try {
    await pool.query(sql);
    console.log('✅ Subscription migration completed successfully!');

    // Verify plans were seeded
    const plans = await pool.query('SELECT id, name, employee_limit, max_inventory_items FROM plans ORDER BY id');
    console.log('\n📋 Plans seeded:');
    plans.rows.forEach(p =>
      console.log(`  • Plan ${p.id}: ${p.name} | Employees: ${p.employee_limit ?? 'Unlimited'} | Inventory: ${p.max_inventory_items ?? 'Unlimited'}`)
    );

    // Verify companies columns
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'companies' AND column_name IN ('trial_ends_at','is_on_trial','is_first_login')`
    );
    console.log('\n📋 New companies columns:', cols.rows.map(r => r.column_name).join(', '));

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

runMigration();
