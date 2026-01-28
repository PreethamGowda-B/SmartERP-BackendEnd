const { pool } = require('../db');
const fs = require('fs');
const path = require('path');

async function runMigration() {
    try {
        console.log('🚀 Starting multi-tenant migration...');

        // Read the migration SQL file
        const migrationPath = path.join(__dirname, '..', 'migrations', '001_add_companies.sql');
        const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

        // Execute the migration
        await pool.query(migrationSQL);

        console.log('✅ Migration completed successfully!');
        console.log('\n📋 Summary:');
        console.log('  - Created companies table');
        console.log('  - Added company_id to users table');
        console.log('  - Added company_id to jobs table');
        console.log('  - Added company_id to all other relevant tables');
        console.log('  - Created indexes for performance');

        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        console.error(err);
        process.exit(1);
    }
}

runMigration();
