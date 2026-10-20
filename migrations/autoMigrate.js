const { pool } = require('../db');
const { storage } = require('../middleware/als');
const fs = require('fs');
const path = require('path');

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
            console.log(`⚠️  Missing columns: ${missingCols.join(', ')} — adding missing columns...`);
            await addMissingColumns(missingCols);
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

async function addMissingColumns(missingCols) {
    const COLUMN_DEFINITIONS = {
        item_name: 'VARCHAR(255) NOT NULL DEFAULT \'\'',
        quantity: 'INTEGER NOT NULL DEFAULT 1',
        urgency: 'VARCHAR(50) DEFAULT \'Medium\'',
        description: 'TEXT',
        status: 'VARCHAR(50) DEFAULT \'pending\'',
        requested_by: 'UUID',
        requested_by_name: 'VARCHAR(255)',
        created_at: 'TIMESTAMP DEFAULT NOW()',
        updated_at: 'TIMESTAMP DEFAULT NOW()',
        reviewed_by: 'UUID',
        reviewed_at: 'TIMESTAMP',
        job_id: 'INTEGER',
        material_id: 'INTEGER',
        company_id: 'INTEGER',
        unit: 'VARCHAR(20)',
        notes: 'TEXT'
    };

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const col of missingCols) {
            const def = COLUMN_DEFINITIONS[col] || 'TEXT';
            await client.query(`ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS ${col} ${def}`);
        }
        await client.query('CREATE INDEX IF NOT EXISTS idx_material_requests_status ON material_requests(status)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_material_requests_requested_by ON material_requests(requested_by)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_material_requests_created_at ON material_requests(created_at DESC)');
        await client.query('COMMIT');
        console.log(`✅ Added missing columns to material_requests: ${missingCols.join(', ')}`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Failed to add missing columns to material_requests:', err.message);
        throw err;
    } finally {
        client.release();
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

        // ALTER column — drop NOT NULL first so we can safely cast
        await client.query(`ALTER TABLE material_requests ALTER COLUMN requested_by DROP NOT NULL`);
        await client.query(`
            ALTER TABLE material_requests
            ALTER COLUMN requested_by TYPE UUID
            USING (
                CASE
                    WHEN requested_by::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN requested_by::text::uuid
                    ELSE NULL
                END
            )
        `);

        await client.query(`ALTER TABLE material_requests ALTER COLUMN reviewed_by DROP NOT NULL`);
        await client.query(`
            ALTER TABLE material_requests
            ALTER COLUMN reviewed_by TYPE UUID
            USING (
                CASE
                    WHEN reviewed_by::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN reviewed_by::text::uuid
                    ELSE NULL
                END
            )
        `);

        // Recreate index
        await client.query(`CREATE INDEX IF NOT EXISTS idx_material_requests_requested_by ON material_requests(requested_by)`);

        await client.query('COMMIT');
        console.log('✅ material_requests.requested_by altered to UUID successfully');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Failed to alter material_requests columns to UUID:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

async function setupDocumentsTable() {
    let client;
    try {
        console.log('🔧 Ensuring employee_documents table exists...');
        client = await pool.connect();
        await client.query('SET ROLE postgres').catch(() => {});
        await client.query(`
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
    } finally {
        if (client) client.release();
    }
}

/**
 * Legacy numbered migrations are retained for explicitly tracked historical
 * upgrades. Production startup uses the separate allow-listed forward runner;
 * this legacy runner refuses to invent a baseline when its ledger is absent.
 */
const NUMBERED_MIGRATIONS = [
    '001_hardening_indexes_and_migration.sql',
    '002_fix_approval_nulls.sql',
    '003_otp_hashing.sql',
    '004_internal_messaging.sql',
    '005_messaging_phase2.sql',
    '006_gst_reconciliation.sql',
    '007_inventory_forecasting.sql',
    '008_ar_collections.sql',
    '009_payroll_validation.sql',
    '011_standardize_uuid_and_core_rls.sql',
    '012_fix_company_settings_company_id_type.sql',
    '013_feedback_enhanced_columns.sql',
    '014_job_actions_system.sql',
    '015_finance_and_invoicing_system.sql',
    '016_direct_walkin_invoices.sql',
    '016b_unified_work_requests.sql',
    '017_enterprise_rbac_and_state_machine.sql',
    '018_ai_copilot_and_audit_logs.sql',
    '019_workforce_gatekeeper_audit_logs.sql',
    '020_cnc_service_edition.sql',
    '021_cnc_phase2.sql',
    '021b_payroll_pre_run_audit_engine.sql',
    '022_cnc_phase3.sql',
    '023_cnc_master_release.sql',
    '024_secure_account_deletion.sql',
    '025_security_ai_infrastructure.sql',
    '026_password_reset_recovery_system.sql',
    '027_refresh_tokens_updated_at.sql',
    '028_material_purchase_verification.sql',
    '029_customer_notification_read_state.sql',
    '030_invoice_idempotency.sql',
    '031_material_request_job_scope.sql',
    '032_attendance_runtime_and_corrections.sql',
    '033_production_dispatch.sql',
    '034_production_dispatch_privileges.sql',
    '035_production_packing_workflow.sql',
    '036_customer_manufacturing_requests.sql',
    '037_subscription_catalog_and_storage.sql',
];

async function runNumberedMigrations() {
    return storage.run({ bypassRls: true }, async () => {
        let setupClient;
        const appliedSet = new Set();
        const failedMigrations = [];
        try {
            setupClient = await pool.connect();
            await setupClient.query('RESET ROLE');
            const ledgerCheck = await setupClient.query(
                "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists"
            );
            if (!ledgerCheck.rows[0]?.exists) {
                return {
                    success: false,
                    appliedMigrations: [],
                    skippedMigrations: [],
                    failedMigrations: [{
                        filename: 'schema_migrations',
                        error: 'Legacy migration history is absent; refusing to replay historical migrations.',
                    }],
                };
            }
            const existingRows = await setupClient.query('SELECT name FROM schema_migrations');
            if (existingRows.rows.length === 0) {
                return {
                    success: false,
                    appliedMigrations: [],
                    skippedMigrations: [],
                    failedMigrations: [{
                        filename: 'schema_migrations',
                        error: 'Legacy migration history is empty; refusing to replay historical migrations.',
                    }],
                };
            }
            for (const row of existingRows.rows) {
                appliedSet.add(row.name);
            }
        } catch (setupErr) {
            return {
                success: false,
                appliedMigrations: [],
                skippedMigrations: [],
                failedMigrations: [{ filename: 'schema_migrations', error: setupErr.message }],
            };
        } finally {
            if (setupClient) setupClient.release();
        }

        const appliedMigrations = [];
        const skippedMigrations = [];

        for (const filename of NUMBERED_MIGRATIONS) {
            if (appliedSet.has(filename)) {
                skippedMigrations.push(filename);
                continue;
            }

            const filePath = path.join(__dirname, filename);
            let client;
            try {
                const rawSql = fs.readFileSync(filePath, 'utf8');
                // Strip outermost BEGIN and COMMIT so the runner client controls the transaction atomically
                const cleanSql = rawSql
                    .replace(/^\s*BEGIN\s*;/im, '-- BEGIN;')
                    .replace(/COMMIT\s*;\s*$/im, '-- COMMIT;');

                client = await pool.connect();
                await client.query('RESET ROLE').catch(() => {});
                await client.query('BEGIN');
                await client.query(cleanSql);
                await client.query(
                    'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
                    [filename]
                );
                await client.query('COMMIT');
                appliedMigrations.push(filename);
                appliedSet.add(filename);
                console.log(`✅ Migration applied: ${filename}`);
            } catch (err) {
                if (client) {
                    try { await client.query('ROLLBACK'); } catch (_) {}
                }
                failedMigrations.push({ filename, error: err.message });
                console.error(`❌ Migration failed (${filename}):`, err.message);
                // Fail closed: Stop subsequent migrations from running if a prerequisite migration fails
                break;
            } finally {
                if (client) client.release();
            }
        }

        const success = failedMigrations.length === 0;
        return { success, appliedMigrations, skippedMigrations, failedMigrations };
    });
}

module.exports = { fixMaterialRequestsSchema, setupDocumentsTable, runNumberedMigrations, NUMBERED_MIGRATIONS };
