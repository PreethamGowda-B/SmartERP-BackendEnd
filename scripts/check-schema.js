require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../db');

async function main() {
  const allTables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  console.log('All Tables:', allTables.rows.map(x=>x.table_name).join(', '));

  // Check users columns
  const u = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position");
  console.log('users:', u.rows.map(c => c.column_name).join(', '));

  // Check indexes
  const idx = await pool.query(`
    SELECT tablename, indexname FROM pg_indexes 
    WHERE tablename IN ('users','companies','activities','feedback','notifications')
    ORDER BY tablename, indexname
  `);
  console.log('\nIndexes:');
  for (const row of idx.rows) {
    console.log(`  ${row.tablename}.${row.indexname}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
