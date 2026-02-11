const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function runMigration() {
    try {
        console.log('🔄 Running migration: fix_notifications_schema.sql');

        // Read the SQL file
        const migrationPath = path.join(__dirname, 'migrations', 'fix_notifications_schema.sql');
        const sql = fs.readFileSync(migrationPath, 'utf8');

        // Execute the SQL
        await pool.query(sql);

        console.log('✅ Migration completed successfully!');

        // Verify the table structure
        const result = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'notifications' 
      ORDER BY ordinal_position
    `);

        console.log("\n📊 Current table structure:");
        result.rows.forEach(row => {
            console.log(`  - ${row.column_name}: ${row.data_type}`);
        });

    } catch (err) {
        console.error('❌ Migration failed:', err);
    } finally {
        await pool.end();
    }
}

runMigration();
