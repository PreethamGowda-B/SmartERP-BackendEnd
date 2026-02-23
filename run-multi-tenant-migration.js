const { pool } = require('./db');

async function runMigration() {
    const client = await pool.connect();

    try {
        console.log('🚀 Starting multi-tenant migration...\n');

        // Step 1: Create Companies table
        console.log('📋 Step 1: Creating Companies table...');
        await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(20) UNIQUE NOT NULL,
        company_name VARCHAR(255) NOT NULL,
        owner_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
        console.log('✅ Companies table created\n');

        // Step 2: Add company columns to users table
        console.log('📋 Step 2: Adding company columns to users table...');
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_code VARCHAR(20)`);
        console.log('✅ Users table updated\n');

        // Step 3: Create default company
        console.log('📋 Step 3: Creating default company...');
        await client.query(`
      INSERT INTO companies (company_id, company_name, created_at)
      VALUES ('SMR1001', 'Default Company', NOW())
      ON CONFLICT (company_id) DO NOTHING
    `);
        console.log('✅ Default company created\n');

        // Step 4: Link owner and employees to default company
        console.log('📋 Step 4: Linking users to default company...');
        const companyResult = await client.query(`SELECT id FROM companies WHERE company_id = 'SMR1001'`);
        const defaultCompanyId = companyResult.rows[0].id;

        // Link owner
        const ownerResult = await client.query(`SELECT id FROM users WHERE email = 'thepreethu01@gmail.com'`);
        if (ownerResult.rows.length > 0) {
            const ownerId = ownerResult.rows[0].id;

            await client.query(`UPDATE companies SET owner_id = $1 WHERE company_id = 'SMR1001'`, [ownerId]);
            await client.query(`UPDATE users SET company_id = $1, company_code = 'SMR1001' WHERE id = $2`, [defaultCompanyId, ownerId]);

            console.log('✅ Owner linked to company SMR1001');
        } else {
            console.log('⚠️  Owner email not found');
        }

        // Link all existing employees
        await client.query(`
      UPDATE users 
      SET company_id = $1, company_code = 'SMR1001'
      WHERE company_id IS NULL AND role != 'owner'
    `, [defaultCompanyId]);
        console.log('✅ Employees linked to company SMR1001\n');

        // Step 5: Add company_id to business tables
        console.log('📋 Step 5: Adding company_id to business tables...');

        await client.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
        await client.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
        await client.query(`ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
        await client.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
        await client.query(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
        await client.query(`ALTER TABLE payroll_entries ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
        await client.query(`ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
        await client.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);

        console.log('✅ Business tables updated\n');

        // Step 6: Backfill company_id
        console.log('📋 Step 6: Backfilling company_id for existing data...');

        await client.query(`UPDATE jobs SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
        await client.query(`UPDATE inventory_items SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
        await client.query(`UPDATE material_requests SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
        await client.query(`UPDATE notifications SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
        await client.query(`UPDATE payroll_runs SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
        await client.query(`UPDATE payroll_entries SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
        await client.query(`UPDATE employee_profiles SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
        await client.query(`UPDATE activities SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);

        console.log('✅ Data backfilled\n');

        // Step 7: Create indexes
        console.log('📋 Step 7: Creating indexes...');

        await client.query(`CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_users_company_code ON users(company_code)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_company_id ON inventory_items(company_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_material_requests_company_id ON material_requests(company_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id)`);

        console.log('✅ Indexes created\n');

        // Step 8: Create sequence
        console.log('📋 Step 8: Creating company ID sequence...');
        await client.query(`CREATE SEQUENCE IF NOT EXISTS company_id_seq START WITH 1002`);
        console.log('✅ Sequence created\n');

        // Verification
        console.log('📊 Verifying migration...\n');

        const companiesCount = await client.query('SELECT COUNT(*) as count FROM companies');
        console.log(`   Companies created: ${companiesCount.rows[0].count}`);

        const usersCount = await client.query('SELECT COUNT(*) as count FROM users WHERE company_id IS NOT NULL');
        console.log(`   Users linked to companies: ${usersCount.rows[0].count}`);

        const jobsCount = await client.query('SELECT COUNT(*) as count FROM jobs WHERE company_id IS NOT NULL');
        console.log(`   Jobs linked to companies: ${jobsCount.rows[0].count}`);

        const defaultCompany = await client.query(`
      SELECT c.*, u.email as owner_email 
      FROM companies c 
      LEFT JOIN users u ON c.owner_id = u.id 
      WHERE c.company_id = 'SMR1001'
    `);

        if (defaultCompany.rows.length > 0) {
            console.log('\n📋 Default Company Details:');
            console.log(`   Company ID: ${defaultCompany.rows[0].company_id}`);
            console.log(`   Company Name: ${defaultCompany.rows[0].company_name}`);
            console.log(`   Owner Email: ${defaultCompany.rows[0].owner_email || 'Not assigned'}`);
        }

        console.log('\n✅ Multi-tenant migration completed successfully!');

    } catch (err) {
        console.error('\n❌ Migration failed:', err.message);
        console.error(err.stack);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

runMigration()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
