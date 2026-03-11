const { pool } = require('./db');

async function checkTypes() {
  try {
    const result = await pool.query(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE (table_name = 'users' AND column_name IN ('id', 'company_id'))
         OR (table_name = 'companies' AND column_name IN ('id', 'owner_id'))
         OR (table_name = 'plans' AND column_name = 'id')
         OR (table_name = 'subscriptions' AND column_name IN ('company_id', 'plan_id'))
    `);
    console.log('--- Column Types ---');
    result.rows.forEach(row => {
      console.log(`${row.table_name}.${row.column_name}: ${row.data_type}`);
    });
    console.log('--------------------');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
}

checkTypes();
