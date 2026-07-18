/**
 * Phase 1 RLS Integration Test (raw SQL version)
 *
 * Tests the actual RLS policies + SET ROLE mechanism directly,
 * without the module caching issues of the ALS stub approach.
 *
 * Tests:
 *   1. No SET ROLE + no session vars → still sees rows (confirms RLS not yet applied or owner bypasses)
 *   2. SET ROLE smarterp_app + no company_id → 0 rows (fail-closed)
 *   3. SET ROLE smarterp_app + correct company_id → own rows visible
 *   4. SET ROLE smarterp_app + wrong company_id → 0 rows (cross-tenant blocked)
 *   5. RESET ROLE (bypass) → all rows visible
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let passed = 0;
let failed = 0;

function assert(label, condition, extra = '') {
  if (condition) {
    console.log(`  ✅  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌  FAIL: ${label}${extra ? ' — ' + extra : ''}`);
    failed++;
  }
}

async function withClient(setupFn, queryFn) {
  const client = await pool.connect();
  try {
    // Always start clean — RESET ROLE and clear all app session variables
    // before each test to prevent pool connection state bleed.
    await client.query('RESET ROLE');
    await client.query(`
      SELECT
        set_config('app.bypass_rls',         'off', true),
        set_config('app.current_company_id', '',    true),
        set_config('app.current_role',       '',    true)
    `);
    await setupFn(client);
    return await queryFn(client);
  } finally {
    // Clean up after ourselves so the recycled connection starts neutral
    await client.query('RESET ROLE');
    await client.query(`
      SELECT
        set_config('app.bypass_rls',         'off', true),
        set_config('app.current_company_id', '',    true),
        set_config('app.current_role',       '',    true)
    `);
    client.release();
  }
}

async function main() {
  console.log('🔒 SmartERP Phase 1 — RLS Integration Tests (raw SQL)\n');

  // ── Setup: find company IDs ───────────────────────────────────────────────
  const setupClient = await pool.connect();
  let companyIds;
  try {
    const r = await setupClient.query('SELECT id FROM companies LIMIT 3');
    companyIds = r.rows.map(row => String(row.id));
    console.log(`   Companies available: ${companyIds.join(', ')}\n`);
  } finally {
    setupClient.release();
  }

  if (companyIds.length === 0) {
    console.error('No companies found — cannot run tests');
    process.exit(1);
  }

  const [cid1, cid2] = [companyIds[0], companyIds[1] || companyIds[0]];

  // ── Get ground truth counts via neondb_owner (BYPASSRLS) ─────────────────
  const { rows: [{ total }] } = await pool.query('SELECT COUNT(*) AS total FROM jobs');
  const { rows: [{ c1count }] } = await pool.query(
    'SELECT COUNT(*) AS c1count FROM jobs WHERE company_id::text = $1', [cid1]
  );
  const { rows: [{ c2count }] } = await pool.query(
    'SELECT COUNT(*) AS c2count FROM jobs WHERE company_id::text = $1', [cid2]
  );
  console.log(`   Ground truth (bypassing RLS): total=${total}, company ${cid1}=${c1count}, company ${cid2}=${c2count}\n`);

  // ── Test 1: neondb_owner (BYPASSRLS role) ─────────────────────────────────
  console.log('📋 Test 1: neondb_owner (BYPASSRLS) sees all rows');
  const t1 = await withClient(
    async (c) => { /* no SET ROLE — stays as neondb_owner */ },
    async (c) => {
      const r = await c.query('SELECT COUNT(*) AS n FROM jobs');
      return parseInt(r.rows[0].n);
    }
  );
  assert(`owner sees all ${total} rows`, t1 === parseInt(total), `got ${t1}`);

  // ── Test 2: smarterp_app + no company_id = fail-closed ───────────────────
  console.log('\n📋 Test 2: smarterp_app + no session vars = 0 rows (fail-closed)');
  const t2 = await withClient(
    async (c) => {
      await c.query('SET ROLE smarterp_app');
      await c.query(`SELECT
        set_config('app.bypass_rls',         'off', true),
        set_config('app.current_company_id', '',    true),
        set_config('app.current_role',       '',    true)`);
    },
    async (c) => {
      const r = await c.query('SELECT COUNT(*) AS n FROM jobs');
      return parseInt(r.rows[0].n);
    }
  );
  assert('0 rows with no company_id (fail-closed)', t2 === 0, `got ${t2}`);

  // ── Test 3: smarterp_app + correct company_id = own rows ─────────────────
  console.log(`\n📋 Test 3: smarterp_app + company_id=${cid1} = own rows only`);
  const t3 = await withClient(
    async (c) => {
      await c.query('SET ROLE smarterp_app');
      await c.query(
        `SELECT
           set_config('app.bypass_rls',         'off', true),
           set_config('app.current_company_id', $1,    true),
           set_config('app.current_role',       'admin', true)`,
        [cid1]
      );
    },
    async (c) => {
      const r = await c.query('SELECT COUNT(*) AS n FROM jobs');
      return parseInt(r.rows[0].n);
    }
  );
  assert(`sees ${c1count} rows for company ${cid1}`, t3 === parseInt(c1count), `got ${t3}`);

  // ── Test 4: smarterp_app + wrong company_id = 0 cross-tenant rows ─────────
  if (cid1 !== cid2) {
    console.log(`\n📋 Test 4: smarterp_app + company_id=${cid1} cannot see company ${cid2} rows`);
    const t4 = await withClient(
      async (c) => {
        await c.query('SET ROLE smarterp_app');
        await c.query(
          `SELECT
             set_config('app.bypass_rls',         'off', true),
             set_config('app.current_company_id', $1,    true),
             set_config('app.current_role',       'admin', true)`,
          [cid1]
        );
      },
      async (c) => {
        // Directly query for other company's rows — policy should block them
        const r = await c.query(
          'SELECT COUNT(*) AS n FROM jobs WHERE company_id::text = $1', [cid2]
        );
        return parseInt(r.rows[0].n);
      }
    );
    assert(`0 cross-tenant rows (company ${cid2} blocked for company ${cid1} session)`, t4 === 0, `got ${t4}`);
  } else {
    console.log('\n📋 Test 4: SKIPPED — only one company');
  }

  // ── Test 5: bypass ('on') = all rows ──────────────────────────────────────
  console.log('\n📋 Test 5: smarterp_app + bypass=on = all rows visible');
  const t5 = await withClient(
    async (c) => {
      await c.query('SET ROLE smarterp_app');
      await c.query(`SELECT
        set_config('app.bypass_rls',         'on', true),
        set_config('app.current_company_id', '',   true),
        set_config('app.current_role',       '',   true)`);
    },
    async (c) => {
      const r = await c.query('SELECT COUNT(*) AS n FROM jobs');
      return parseInt(r.rows[0].n);
    }
  );
  assert(`bypass sees all ${total} rows`, t5 === parseInt(total), `got ${t5}`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
