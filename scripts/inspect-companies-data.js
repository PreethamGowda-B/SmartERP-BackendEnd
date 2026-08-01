const { pool } = require('../db');

async function inspectCompaniesData() {
  const res = await pool.query(`SELECT id, company_id, company_name FROM companies LIMIT 5;`);
  console.log('📋 companies sample data:', res.rows);
  
  const fkCheck = await pool.query(`
    SELECT
      tc.table_name, kcu.column_name, 
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name 
    FROM 
      information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'companies';
  `);
  console.log('📋 Existing FKs referencing companies:', fkCheck.rows);
  
  process.exit(0);
}

inspectCompaniesData().catch(err => { console.error(err); process.exit(1); });
