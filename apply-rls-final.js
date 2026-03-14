const { pool } = require('./db');

async function applyRLS() {
    // List of tables to protect with RLS
    const tables = [
        'users', 
        'attendance', 
        'jobs', 
        'material_requests', 
        'inventory_items', 
        'notifications', 
        'activities', 
        'payroll',
        'leaves'
    ];

    try {
        console.log('--- Applying Row-Level Security (RLS) ---');
        
        for (const table of tables) {
            // Check if table exists
            const checkTable = await pool.query(
                "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)",
                [table]
            );

            if (!checkTable.rows[0].exists) {
                console.log(`Table '${table}' does not exist, skipping...`);
                continue;
            }

            console.log(`Protecting table: ${table}`);
            
            // 1. Enable RLS
            await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
            
            // 2. Drop existing policy if any
            await pool.query(`DROP POLICY IF EXISTS ${table}_isolation_policy ON ${table}`);
            
            // 3. Create isolation policy
            // This policy ensures the company_id column matches the session variable
            await pool.query(`
                CREATE POLICY ${table}_isolation_policy ON ${table}
                USING (company_id::text = current_setting('app.current_company_id', true))
            `);
            
            console.log(`✅ ${table} is now secured with RLS.`);
        }

        console.log('--- RLS Migration Complete ---');
        process.exit(0);
    } catch (err) {
        console.error('RLS Migration Failed:', err.message);
        process.exit(1);
    }
}

applyRLS();
