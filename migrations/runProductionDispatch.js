const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { storage } = require('../middleware/als');
const { STARTUP_MIGRATIONS, applyForwardMigration } = require('./forwardMigrationRunner');

async function runProductionDispatchMigration() {
  return storage.run({ bypassRls: true }, async () => {
    const results = [];
    for (const migration of STARTUP_MIGRATIONS) {
      const sql = fs.readFileSync(path.join(__dirname, migration.file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('RESET ROLE');
        const target = await client.query(`
          SELECT current_database() AS database_name,
                 current_user AS database_role,
                 has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public
        `);
        if (!target.rows[0]?.can_create_in_public) {
          throw new Error(`Connected database role cannot create objects in public; ${migration.id} was not applied.`);
        }
        results.push(await applyForwardMigration(client, { migrationId: migration.id, sql }));
      } finally {
        client.release();
      }
    }
    return results;
  });
}

if (require.main === module) {
  runProductionDispatchMigration()
    .then((results) => {
      for (const result of results) {
        console.log(`Migration ${result.migrationId}: ${result.status}`);
      }
      return pool.end();
    })
    .catch(async (error) => {
      console.error(`Migration failed: ${error.message}`);
      try { await pool.end(); } catch (_) { /* preserve migration failure */ }
      process.exitCode = 1;
    });
}

module.exports = { runProductionDispatchMigration };
