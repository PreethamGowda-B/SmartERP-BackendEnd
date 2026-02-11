const { pool } = require('./db');

async function inspectSchema() {
    try {
        const res = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
        console.log('Tables:', res.rows.map(r => r.table_name));

        const companiesTable = res.rows.find(r => r.table_name === 'companies');
        if (companiesTable) {
            console.log('\nDescribing companies table:');
            const cols = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns 
        WHERE table_name = 'companies'
      `);
            console.log(cols.rows);
        } else {
            console.log('\nCompanies table not found.');
        }
    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

inspectSchema();
