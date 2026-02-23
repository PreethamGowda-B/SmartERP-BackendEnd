const { pool } = require('../db');

/**
 * Auto-migration: Fix material_requests table schema
 * Runs automatically on server startup to ensure the schema is correct.
 *
 * The correct schema uses INTEGER for requested_by and reviewed_by
 * because users.id is a SERIAL (INTEGER) in this database.
 */
async function fixMaterialRequestsSchema() {
    try {
        console.log('🔧 Checking material_requests table schema...');

        // Check if the table exists at all
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'material_requests'
            ) AS exists
        `);

        const tableExists = tableCheck.rows[0].exists;

        if (!tableExists) {
            console.log('📋 material_requests table not found — creating...');
            await createTable();
            return;
        }

        // Table exists — check that all required columns are present with correct types
        const colCheck = await pool.query(`
            SELECT column_name, data_type
            FROM information_schema.columns 
            WHERE table_name = 'material_requests'
        `);

        const existingCols = {};
        for (const row of colCheck.rows) {
            existingCols[row.column_name] = row.data_type;
        }

        console.log('📋 Existing columns:', Object.keys(existingCols).join(', '));

        const requiredCols = [
            'id', 'item_name', 'quantity', 'urgency', 'description',
            'status', 'requested_by', 'requested_by_name',
            'created_at', 'updated_at', 'reviewed_by', 'reviewed_at'
        ];

        const missingCols = requiredCols.filter(col => !(col in existingCols));
        const wrongType = existingCols['requested_by'] && existingCols['requested_by'] === 'uuid';

        if (missingCols.length > 0) {
            console.log(`⚠️  Missing columns: ${missingCols.join(', ')} — recreating table...`);
            await recreateTable();
        } else if (wrongType) {
            console.log('⚠️  requested_by is UUID type — should be INTEGER — recreating...');
            await recreateTable();
        } else {
            console.log('✅ material_requests table schema is correct');
        }

    } catch (err) {
        console.error('❌ Error fixing material_requests schema:', err.message);
        // Don't crash the server - just log the error
    }
}

async function createTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS material_requests (
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
        );
        
        CREATE INDEX IF NOT EXISTS idx_material_requests_status ON material_requests(status);
        CREATE INDEX IF NOT EXISTS idx_material_requests_requested_by ON material_requests(requested_by);
        CREATE INDEX IF NOT EXISTS idx_material_requests_created_at ON material_requests(created_at DESC);
    `);
    console.log('✅ material_requests table created successfully');
}

async function recreateTable() {
    // Use a transaction so we don't leave a half-broken state
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DROP TABLE IF EXISTS material_requests CASCADE');
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
        await client.query(`
            CREATE INDEX idx_material_requests_status ON material_requests(status);
            CREATE INDEX idx_material_requests_requested_by ON material_requests(requested_by);
            CREATE INDEX idx_material_requests_created_at ON material_requests(created_at DESC);
        `);
        await client.query('COMMIT');
        console.log('✅ material_requests table recreated with correct schema');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Failed to recreate material_requests table:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { fixMaterialRequestsSchema };
