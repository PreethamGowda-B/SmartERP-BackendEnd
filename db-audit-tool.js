const { pool } = require('./db');

async function auditDatabase() {
  try {
    console.log('--- TABLES ---');
    const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
    console.log(tables.rows.map(r => r.table_name).join(', '));

    console.log('\n--- COLUMN DATA TYPES (Potential Mismatches) ---');
    const columns = await pool.query(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND column_name IN ('id', 'company_id', 'owner_id', 'user_id', 'employee_id')
      ORDER BY column_name, table_name
    `);
    console.table(columns.rows);

    console.log('\n--- INDEXES ---');
    const indexes = await pool.query(`
      SELECT tablename, indexname, indexdef 
      FROM pg_indexes 
      WHERE schemaname = 'public' 
      ORDER BY tablename, indexname
    `);
    console.table(indexes.rows);

    console.log('\n--- CONSTRAINTS ---');
    const constraints = await pool.query(`
      SELECT 
        conname as constraint_name, 
        conrelid::regclass as table_name, 
        confrelid::regclass as foreign_table,
        pg_get_constraintdef(oid) as definition
      FROM pg_constraint 
      WHERE connamespace = 'public'::regnamespace
      ORDER BY conrelid::regclass::text
    `);
    console.table(constraints.rows);

    console.log('\n--- NULLABLE company_id CHECK ---');
    const nullableCompanyId = await pool.query(`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND column_name = 'company_id'
      AND is_nullable = 'YES'
    `);
    console.table(nullableCompanyId.rows);

  } catch (err) {
    console.error('Audit Error:', err);
  } finally {
    await pool.end();
  }
}

auditDatabase();
