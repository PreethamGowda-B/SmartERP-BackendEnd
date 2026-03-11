const { pool } = require('./db');

async function fixForeignKey() {
  const client = await pool.connect();
  try {
    console.log('🚀 Fixing users.company_id foreign key constraint...\n');

    // 1. Drop the incorrect constraint
    console.log('📋 Dropping old constraint: users_company_id_fkey...');
    await client.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_company_id_fkey');

    // 2. Add the correct constraint pointing to companies(id)
    console.log('📋 Adding new constraint: users_company_id_fkey pointing to companies(id)...');
    await client.query(`
      ALTER TABLE users 
      ADD CONSTRAINT users_company_id_fkey 
      FOREIGN KEY (company_id) 
      REFERENCES companies(id)
    `);
    
    console.log('✅ Foreign key redirected successfully!');

    // 3. Verify
    const result = await client.query(`
      SELECT
          tc.table_name, 
          kcu.column_name, 
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name 
      FROM 
          information_schema.table_constraints AS tc 
          JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name='users' AND kcu.column_name='company_id';
    `);
    
    if (result.rows.length > 0) {
      const row = result.rows[0];
      console.log(`Verification: ${row.table_name}.${row.column_name} -> ${row.foreign_table_name}.${row.foreign_column_name}`);
    }

  } catch (err) {
    console.error('❌ Fix failed:', err.message);
    if (err.detail) console.error('Detail:', err.detail);
  } finally {
    client.release();
    await pool.end();
  }
}

fixForeignKey();
