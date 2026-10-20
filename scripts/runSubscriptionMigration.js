'use strict';

// Migration 037 is intentionally separated from ordinary startup. This script
// uses a dedicated connection and requires a DBA-provisioned identity marker.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { storage } = require('../middleware/als');
const { applyForwardMigration, FORWARD_MIGRATIONS } = require('../migrations/forwardMigrationRunner');
const {
  assertIsolatedTarget,
  assertTargetConfiguration,
  assertLegacyPlanMapping,
  assertCanonicalPlans,
  assertSubscriptionSchema,
} = require('./subscriptionMigrationChecks');

const MIGRATION_ID = '037_subscription_catalog_and_storage';

async function runMigration() {
  if (process.env.SMARTERP_SUBSCRIPTION_SEED_CONFIRM !== 'APPLY_TO_CONFIRMED_TEST_DATABASE') {
    throw new Error('Refusing to run without explicit subscription test-database confirmation.');
  }
  const target = assertTargetConfiguration(process.env);
  const connectionString = process.env.SMARTERP_SUBSCRIPTION_TEST_DATABASE_URL;
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(target.host);
  const pool = new Pool({
    connectionString,
    ssl: isLoopback ? false : { rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 8000,
    statement_timeout: 15000,
    application_name: 'smarterp-subscription-migration',
  });

  try {
    return await storage.run({ bypassRls: true }, async () => {
      const client = await pool.connect();
      try {
        await client.query('RESET ROLE');
        // This dedicated raw Pool does not inherit db.js's ALS hook. Set the
        // same migration-only tenant bypass explicitly for RLS-protected
        // backfills and verification on this single client.
        await client.query("SELECT set_config('app.bypass_rls', 'true', false), set_config('app.current_company_id', '', false)");
        const identityResult = await client.query(`
          SELECT current_database() AS database_name,
                 current_user AS database_role,
                 current_setting('port') AS port,
                 (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid
        `);
        const identity = {
          ...identityResult.rows[0],
          host: target.host,
        };
        const roleResult = await client.query(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
        );
        const markerExists = await client.query(
          "SELECT to_regclass('public.smarterp_test_database_identity') IS NOT NULL AS exists"
        );
        let marker = null;
        if (markerExists.rows[0]?.exists) {
          const markerResult = await client.query(`
            SELECT environment, isolation_id, database_name, database_role, database_oid::text
              FROM public.smarterp_test_database_identity
             WHERE singleton IS TRUE
          `);
          if (markerResult.rows.length === 1) marker = markerResult.rows[0];
        }
        assertIsolatedTarget({ env: process.env, identity, role: roleResult.rows[0], marker });

        const legacyPlans = await client.query(
          'SELECT id, name FROM plans WHERE id IN (1,2,3) ORDER BY id'
        );
        assertLegacyPlanMapping(legacyPlans.rows);

        const migration = FORWARD_MIGRATIONS.find(item => item.id === MIGRATION_ID);
        if (!migration) throw new Error('Subscription migration is not registered in the forward migration allow-list.');
        const sql = fs.readFileSync(path.join(__dirname, '../migrations', migration.file), 'utf8');
        const result = await applyForwardMigration(client, { migrationId: MIGRATION_ID, sql });

        const supportPolicyColumn = await client.query(`
          SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='plans' AND column_name='support_policy') AS present
        `);
        const supportPolicySelection = supportPolicyColumn.rows[0]?.present ? ', support_policy' : '';
        const plans = await client.query(
          `SELECT id, name, price_monthly, price_yearly, employee_limit,
                  max_active_jobs, max_inventory_items, max_storage_bytes,
                  max_material_requests, messages_history_days, features${supportPolicySelection}
             FROM plans WHERE id IN (1,2,3) ORDER BY id`
        );
        assertCanonicalPlans(plans.rows);
        await assertSubscriptionSchema(client);
        console.log(`Subscription migration ${result.status}; verified isolated database ${identity.database_name} as role ${identity.database_role}.`);
        return result;
      } finally {
        client.release();
      }
    });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runMigration().catch(error => {
    // Error messages contain validation outcomes only; never print a URL or secret.
    console.error(`Subscription migration not applied or not verified: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runMigration };
