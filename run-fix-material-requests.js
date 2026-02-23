/**
 * Run this script locally to fix the material_requests table on the live Neon DB.
 * This bypasses Render entirely and connects directly to the database.
 * 
 * Usage: node run-fix-material-requests.js
 */
require('dotenv').config();
const { pool } = require('./db');

async function fixMaterialRequests() {
    console.log('🔧 Connecting to Neon DB...');
    const client = await pool.connect();

    try {
        // Step 1: Check current state
        console.log('\n📋 Checking current table state...');
        const colCheck = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'material_requests'
            ORDER BY ordinal_position
        `);

        if (colCheck.rows.length === 0) {
            console.log('⚠️  Table does not exist yet');
        } else {
            console.log('Current columns:');
            colCheck.rows.forEach(r => console.log(`  - ${r.column_name}: ${r.data_type}`));
        }

        // Step 2: Drop and recreate
        console.log('\n🔄 Dropping and recreating material_requests table...');
        await client.query('BEGIN');

        await client.query('DROP TABLE IF EXISTS material_requests CASCADE');
        console.log('✅ Dropped old table');

        await client.query(`
            CREATE TABLE material_requests (
                id SERIAL PRIMARY KEY,
                item_name VARCHAR(255) NOT NULL,
                quantity INTEGER NOT NULL,
                urgency VARCHAR(50) DEFAULT 'Medium',
                description TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                requested_by INTEGER NOT NULL,
                requested_by_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                reviewed_by INTEGER,
                reviewed_at TIMESTAMP
            )
        `);
        console.log('✅ Created new table with correct schema');

        await client.query(`CREATE INDEX idx_material_requests_status ON material_requests(status)`);
        await client.query(`CREATE INDEX idx_material_requests_requested_by ON material_requests(requested_by)`);
        await client.query(`CREATE INDEX idx_material_requests_created_at ON material_requests(created_at DESC)`);
        console.log('✅ Created indexes');

        await client.query('COMMIT');
        console.log('\n✅ Transaction committed successfully!');

        // Step 3: Verify
        const verify = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'material_requests'
            ORDER BY ordinal_position
        `);
        console.log('\n📋 Final table schema:');
        verify.rows.forEach(r => console.log(`  ✓ ${r.column_name}: ${r.data_type}`));

        console.log('\n🎉 Material requests table fixed! The 500 error should be gone.');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('\n❌ Fix failed:', err.message);
        console.error('Code:', err.code);
        console.error('Detail:', err.detail);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

fixMaterialRequests();
