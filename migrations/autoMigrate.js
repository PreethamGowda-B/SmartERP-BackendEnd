const { pool } = require('../db');

/**
 * Auto-migration: Fix material_requests table schema
 * Runs automatically on server startup to ensure the schema is correct.
 *
 * users.id is UUID — so requested_by and reviewed_by must also be UUID.
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

        // Check for wrong type — requested_by should be UUID (users.id is UUID)  
        const requestedByType = existingCols['requested_by'];
        const isWrongType = requestedByType && requestedByType !== 'uuid' && requestedByType !== 'character varying';

        if (missingCols.length > 0) {
            console.log(`⚠️  Missing columns: ${missingCols.join(', ')} — recreating table...`);
            await recreateTable();
        } else if (isWrongType) {
            console.log(`⚠️  requested_by is ${requestedByType} — expected UUID — running ALTER...`);
            await alterToUuid();
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
            requested_by UUID,
            requested_by_name VARCHAR(255),
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            reviewed_by UUID,
            reviewed_at TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_material_requests_status ON material_requests(status);
        CREATE INDEX IF NOT EXISTS idx_material_requests_requested_by ON material_requests(requested_by);
        CREATE INDEX IF NOT EXISTS idx_material_requests_created_at ON material_requests(created_at DESC);
    `);
    console.log('✅ material_requests table created successfully with UUID columns');
}

async function alterToUuid() {
    // ALTER the column types from INTEGER → UUID without losing data
    // (existing integer rows won't cast but we drop data anyway since they're corrupted references)
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Drop the old constraints/indexes first
        await client.query(`DROP INDEX IF EXISTS idx_material_requests_requested_by`);

        // ALTER column — drop NOT NULL first so we can set to NULL during cast
        await client.query(`ALTER TABLE material_requests ALTER COLUMN requested_by DROP NOT NULL`);
        await client.query(`ALTER TABLE material_requests ALTER COLUMN requested_by TYPE UUID USING NULL`);

        await client.query(`ALTER TABLE material_requests ALTER COLUMN reviewed_by DROP NOT NULL`);
        await client.query(`ALTER TABLE material_requests ALTER COLUMN reviewed_by TYPE UUID USING NULL`);

        // Recreate index
        await client.query(`CREATE INDEX IF NOT EXISTS idx_material_requests_requested_by ON material_requests(requested_by)`);

        await client.query('COMMIT');
        console.log('✅ material_requests.requested_by altered to UUID successfully');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Failed to alter material_requests columns to UUID:', err.message);
        // Last resort: drop and recreate
        console.log('⚠️  Falling back to table recreation...');
        await recreateTable();
    } finally {
        client.release();
    }
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
                requested_by UUID,
                requested_by_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                reviewed_by UUID,
                reviewed_at TIMESTAMP
            )
        `);
        await client.query(`
            CREATE INDEX idx_material_requests_status ON material_requests(status);
            CREATE INDEX idx_material_requests_requested_by ON material_requests(requested_by);
            CREATE INDEX idx_material_requests_created_at ON material_requests(created_at DESC);
        `);
        await client.query('COMMIT');
        console.log('✅ material_requests table recreated with UUID schema');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Failed to recreate material_requests table:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

async function setupDocumentsTable() {
    try {
        console.log('🔧 Ensuring employee_documents table exists...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS employee_documents (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                company_id INTEGER NOT NULL,
                employee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                document_type VARCHAR(100) NOT NULL,
                file_url TEXT NOT NULL,
                notes TEXT,
                uploaded_by UUID REFERENCES users(id),
                created_at TIMESTAMP DEFAULT NOW()
            );
            
            CREATE INDEX IF NOT EXISTS idx_employee_docs_company ON employee_documents(company_id);
            CREATE INDEX IF NOT EXISTS idx_employee_docs_employee ON employee_documents(employee_id);
            CREATE INDEX IF NOT EXISTS idx_employee_docs_type ON employee_documents(document_type);
        `);
        console.log('✅ employee_documents table initialized');
    } catch (err) {
        console.error('❌ Error setting up employee_documents table:', err.message);
    }
}

module.exports = { fixMaterialRequestsSchema, setupDocumentsTable };
