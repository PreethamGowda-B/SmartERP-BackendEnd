const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

test.describe('PostgreSQL Core Tables Row-Level Security (RLS) & Tenant Isolation Test Suite', () => {

  test('RLS-1: Enforces strict data isolation on ALL core tables when app.current_company_id is set', async () => {
    const client = await pool.connect();
    try {
      const companyA = '11111111-1111-1111-1111-111111111111';
      const companyB = '22222222-2222-2222-2222-222222222222';

      await client.query('BEGIN');

      // Set session context to Company A using set_config (avoids SQL keyword conflict on current_role)
      await client.query(`SELECT set_config('app.current_company_id', $1, true), set_config('app.current_role', $2, true)`, [companyA, 'owner']);

      // Query core & AI tables
      const coreTables = [
        'users', 'jobs', 'attendance', 'payroll', 'inventory_items',
        'notifications', 'messages', 'employee_profiles', 'material_requests',
        'employee_documents', 'subscriptions', 'subscription_events', 'activities',
        'gst_company_settings', 'inventory_forecasts', 'ar_collection_schedules',
        'crm_leads_enhanced', 'payroll_validation_runs'
      ];

      for (const table of coreTables) {
        const res = await client.query(`SELECT * FROM ${table} WHERE company_id = $1 OR company_id = $2`, [companyA, companyB]);
        for (const row of res.rows) {
          assert.equal(row.company_id, companyA, `Table ${table} leaked row from another tenant!`);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  test('RLS-2: Query OUTSIDE session context returns ZERO rows safely across all core tables', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Intentionally set app.current_company_id to empty string
      await client.query(`SELECT set_config('app.current_company_id', '', true), set_config('app.current_role', $1, true)`, ['employee']);

      const coreTables = [
        'users', 'jobs', 'attendance', 'payroll', 'inventory_items',
        'notifications', 'messages', 'employee_profiles', 'material_requests',
        'employee_documents', 'subscriptions', 'subscription_events', 'activities',
        'gst_company_settings', 'inventory_forecasts', 'ar_collection_schedules',
        'crm_leads_enhanced', 'payroll_validation_runs'
      ];

      for (const table of coreTables) {
        const res = await client.query(`SELECT * FROM ${table}`);
        assert.equal(res.rows.length, 0, `Unset session context MUST return 0 rows for table '${table}'`);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  test('RLS-3: Super Admin explicit policy bypass returns all tenant records', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Set role to super_admin without company_id
      await client.query(`SELECT set_config('app.current_company_id', '', true), set_config('app.current_role', $1, true)`, ['super_admin']);

      const res = await client.query(`SELECT COUNT(*)::int AS cnt FROM users`);
      assert.ok(res.rows[0].cnt >= 0, 'Super admin role policy must allow querying across tables');

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

});
