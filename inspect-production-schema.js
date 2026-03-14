const { pool } = require('./db');

async function inspectSchema() {
  try {
    console.log('--- Table: attendance ---');
    const attResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'attendance'
    `);
    console.table(attResult.rows);

    console.log('--- Table: activities ---');
    const actResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'activities'
    `);
    console.table(actResult.rows);

    console.log('--- Table: companies ---');
    const compResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'companies'
    `);
    console.table(compResult.rows);

    process.exit(0);
  } catch (err) {
    console.error('Schema inspection failed:', err.message);
    process.exit(1);
  }
}

inspectSchema();
