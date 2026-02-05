const { pool } = require('../db');

/**
 * Auto-migration: Fix material_requests table type mismatch
 * This runs automatically on server startup to ensure the schema is correct
 */
async function fixMaterialRequestsSchema() {
    try {
        console.log('🔧 Checking material_requests table schema...');

        // Check if the table exists and what type requested_by is
        const checkType = await pool.query(`
      SELECT data_type 
      FROM information_schema.columns 
      WHERE table_name = 'material_requests' 
      AND column_name = 'requested_by'
    `);

        if (checkType.rows.length === 0) {
            console.log('📋 Creating material_requests table...');

            // Table doesn't exist, create it
            await pool.query(`
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
        );
        
        CREATE INDEX IF NOT EXISTS idx_material_requests_status ON material_requests(status);
        CREATE INDEX IF NOT EXISTS idx_material_requests_requested_by ON material_requests(requested_by);
        CREATE INDEX IF NOT EXISTS idx_material_requests_created_at ON material_requests(created_at DESC);
      `);

            console.log('✅ Material requests table created successfully');
            return;
        }

        const currentType = checkType.rows[0].data_type;

        if (currentType === 'uuid') {
            console.log('⚠️  Detected UUID type, converting to INTEGER...');

            // Drop and recreate with correct types
            await pool.query(`
        DROP TABLE IF EXISTS material_requests;
        
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
        );
        
        CREATE INDEX idx_material_requests_status ON material_requests(status);
        CREATE INDEX idx_material_requests_requested_by ON material_requests(requested_by);
        CREATE INDEX idx_material_requests_created_at ON material_requests(created_at DESC);
      `);

            console.log('✅ Material requests table schema fixed (UUID → INTEGER)');
        } else if (currentType === 'integer') {
            console.log('✅ Material requests table schema is correct (INTEGER)');
        } else {
            console.log(`⚠️  Unexpected type: ${currentType}`);
        }

    } catch (err) {
        console.error('❌ Error fixing material_requests schema:', err.message);
        // Don't crash the server, just log the error
    }
}

module.exports = { fixMaterialRequestsSchema };
