const { pool } = require('../db');
require('dotenv').config();

async function migrateJobsTable() {
    try {
        console.log('🔧 Starting jobs table migration...');

        // Add all missing columns
        const columns = [
            "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS data JSONB",
            "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS visible_to_all BOOLEAN DEFAULT false",
            "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS employee_status VARCHAR(50) DEFAULT 'pending'",
            "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0",
            "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP",
            "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS declined_at TIMESTAMP",
            "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP",
            "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'medium'"
        ];

        for (const sql of columns) {
            await pool.query(sql);
            console.log('✅', sql);
        }

        console.log('\n✅ Migration completed successfully!');

        // Show current table structure
        const result = await pool.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'jobs'
      ORDER BY ordinal_position
    `);

        console.log('\n📋 Current jobs table structure:');
        console.table(result.rows);

        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        console.error(err);
        process.exit(1);
    }
}

migrateJobsTable();
