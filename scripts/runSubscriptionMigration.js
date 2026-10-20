'use strict';

// Explicit, repeatable provisioning for an isolated subscription test DB only.
// Production/staging startup uses the reviewed forward migration runner.
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { storage } = require('../middleware/als');
const { applyForwardMigration } = require('../migrations/forwardMigrationRunner');

async function runMigration() {
  const confirmation = process.env.SMARTERP_SUBSCRIPTION_SEED_CONFIRM;
  const expectedDatabase = process.env.SMARTERP_SUBSCRIPTION_TEST_DATABASE;
  if (confirmation !== 'APPLY_TO_CONFIRMED_TEST_DATABASE' || !expectedDatabase || !/test/i.test(expectedDatabase)) {
    throw new Error('Refusing to run. Set SMARTERP_SUBSCRIPTION_SEED_CONFIRM=APPLY_TO_CONFIRMED_TEST_DATABASE and SMARTERP_SUBSCRIPTION_TEST_DATABASE to the exact isolated test database name.');
  }

  return storage.run({ bypassRls: true }, async () => {
    const client = await pool.connect();
    try {
    await client.query('RESET ROLE');
    const target = await client.query('SELECT current_database() AS database_name');
    if (target.rows[0]?.database_name !== expectedDatabase) {
      throw new Error(`Connected database name does not match the confirmed test database (${expectedDatabase}); no migration was applied.`);
    }

    const sql = fs.readFileSync(path.join(__dirname, '../migrations/037_subscription_catalog_and_storage.sql'), 'utf8');
    const result = await applyForwardMigration(client, { migrationId: '037_subscription_catalog_and_storage', sql });
    const plans = await client.query(
      `SELECT id, name, price_monthly, price_yearly, employee_limit,
              max_active_jobs, max_inventory_items, max_storage_bytes, features
         FROM plans WHERE id IN (1,2,3) ORDER BY id`
    );
    if (plans.rows.length !== 3) throw new Error('Provisioning verification failed: expected exactly three canonical plan rows.');
    console.log(`Subscription provisioning ${result.status} in confirmed test database ${expectedDatabase}.`);
    for (const plan of plans.rows) {
      console.log(`${plan.id} ${plan.name}: ₹${plan.price_monthly}/month, ₹${plan.price_yearly}/year; seats=${plan.employee_limit ?? 'unlimited'}, jobs=${plan.max_active_jobs ?? 'unlimited'}, inventory=${plan.max_inventory_items ?? 'unlimited'}, storage=${plan.max_storage_bytes ?? 'unlimited'} bytes`);
    }
    } finally {
      client.release();
      await pool.end();
    }
  });
}

runMigration().catch(async (error) => {
  console.error(`Subscription migration not applied: ${error.message}`);
  try { await pool.end(); } catch (_) { /* preserve migration result */ }
  process.exitCode = 1;
});
