const { pool } = require('../db');
require('dotenv').config();

async function fixJobsConstraint() {
    try {
        console.log('🔧 Checking jobs table constraints...\n');

        // Check current constraint
        const constraints = await pool.query(`
      SELECT conname, pg_get_constraintdef(oid) as definition
      FROM pg_constraint
      WHERE conrelid = 'jobs'::regclass
      AND contype = 'c'
    `);

        console.log('📋 Current CHECK constraints:');
        console.table(constraints.rows);

        // Drop the old constraint if it exists
        console.log('\n🗑️  Dropping old status constraint...');
        await pool.query(`
      ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check
    `);

        // Add new constraint that allows more status values
        console.log('✅ Adding new flexible status constraint...');
        await pool.query(`
      ALTER TABLE jobs ADD CONSTRAINT jobs_status_check 
      CHECK (status IN ('open', 'pending', 'in_progress', 'active', 'completed', 'closed', 'cancelled'))
    `);

        console.log('\n✅ Constraint updated successfully!');

        // Verify
        const newConstraints = await pool.query(`
      SELECT conname, pg_get_constraintdef(oid) as definition
      FROM pg_constraint
      WHERE conrelid = 'jobs'::regclass
      AND contype = 'c'
    `);

        console.log('\n📋 New CHECK constraints:');
        console.table(newConstraints.rows);

        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err.message);
        console.error(err);
        process.exit(1);
    }
}

fixJobsConstraint();
