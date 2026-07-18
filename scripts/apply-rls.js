require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Use a raw pool — NOT the patched db.js — so we connect as neondb_owner
// which is the table owner and can run ALTER TABLE / CREATE POLICY DDL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'rls_policies.sql'), 'utf8');

  // Split on semicolons, filter out empty/comment-only blocks
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.match(/^--/));

  console.log(`Applying ${statements.length} statements...\n`);

  let ok = 0;
  let err = 0;
  const client = await pool.connect();

  try {
    // Ensure we're running as neondb_owner (table owner) for all DDL.
    // This is needed in case any previous connection set SET ROLE smarterp_app.
    await client.query('RESET ROLE');
    console.log('  🔑  Running as:', (await client.query('SELECT current_user')).rows[0].current_user);

    for (const stmt of statements) {
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
      try {
        await client.query(stmt);
        console.log(`  ✅  ${preview}`);
        ok++;
      } catch (e) {
        console.error(`  ❌  ${preview}`);
        console.error(`      Error: ${e.message}`);
        err++;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\nDone: ${ok} succeeded, ${err} failed`);
  process.exit(err > 0 ? 1 : 0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
