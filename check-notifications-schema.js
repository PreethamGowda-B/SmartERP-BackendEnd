const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function checkSchema() {
    try {
        const result = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'notifications' 
      ORDER BY ordinal_position
    `);

        console.log("📊 Notifications table structure:");
        result.rows.forEach(row => {
            console.log(`  - ${row.column_name}: ${row.data_type}`);
        });

        const rows = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 5');
        console.log("\nRecent Notifications:");
        console.table(rows.rows);

    } catch (err) {
        console.error('❌ Failed to check schema:', err);
    } finally {
        await pool.end();
    }
}

checkSchema();
