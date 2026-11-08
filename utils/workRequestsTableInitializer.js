'use strict';

const logger = require('./logger');

const REQUIRED_WORK_REQUESTS_COLUMNS = Object.freeze([
  'owner_response',
  'response_notes',
  'actioned_by_id',
  'resolved_by_id'
]);

/**
 * Migration helper executed by the table owner in master startup
 * before application workers start serving requests.
 */
async function ensureWorkRequestsSchemaOwner(client) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A database client with query() is required.');
  }

  await client.query('BEGIN');
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id TEXT,
        request_type VARCHAR(100) NOT NULL,
        category VARCHAR(50) DEFAULT 'jobs',
        urgency VARCHAR(20) DEFAULT 'normal',
        status VARCHAR(20) DEFAULT 'pending',
        submitted_by_id TEXT,
        submitted_by_name VARCHAR(255),
        submitted_by_role VARCHAR(50),
        job_id TEXT,
        invoice_id TEXT,
        material_request_id TEXT,
        leave_request_id TEXT,
        title VARCHAR(255) NOT NULL,
        reason TEXT,
        response_notes TEXT,
        owner_response TEXT,
        actioned_by_id TEXT,
        actioned_by_name VARCHAR(255),
        actioned_at TIMESTAMP WITH TIME ZONE,
        resolved_by_id TEXT,
        resolved_by_name VARCHAR(255),
        resolved_at TIMESTAMP WITH TIME ZONE,
        evidence_urls JSONB DEFAULT '[]'::jsonb,
        payload JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS owner_response TEXT;
      ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS response_notes TEXT;
      ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS actioned_by_id TEXT;
      ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS actioned_by_name VARCHAR(255);
      ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS actioned_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS resolved_by_id TEXT;
      ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS resolved_by_name VARCHAR(255);
      ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP WITH TIME ZONE;
      CREATE INDEX IF NOT EXISTS idx_work_requests_company ON work_requests(company_id);
      CREATE INDEX IF NOT EXISTS idx_work_requests_status ON work_requests(status);
      CREATE INDEX IF NOT EXISTS idx_work_requests_job ON work_requests(job_id);

      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smarterp_app') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE work_requests TO smarterp_app;
        END IF;
      END $$;
    `);

    // Verify schema completeness: ensure required columns are present
    const verifyResult = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'work_requests'
        AND column_name = ANY($1::text[])
    `, [REQUIRED_WORK_REQUESTS_COLUMNS]);

    if (!verifyResult.rows || verifyResult.rows.length < REQUIRED_WORK_REQUESTS_COLUMNS.length) {
      const found = (verifyResult.rows || []).map(r => r.column_name);
      const missing = REQUIRED_WORK_REQUESTS_COLUMNS.filter(c => !found.includes(c));
      throw new Error(`work_requests schema incomplete. Missing columns: ${missing.join(', ')}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

/**
 * Create the legacy work-request schema initializer with process-local
 * single-flight behavior. Application workers rely on the controlled
 * startup migration for table owner DDL and do not attempt failing ALTER queries.
 */
function createWorkRequestsTableInitializer(options = {}) {
  const db = options.db || options.pool;
  const warn = options.warn || ((msg, extra) => logger.warn(msg, extra));
  if (!db || typeof db.connect !== 'function') {
    throw new TypeError('A database pool with connect() is required.');
  }

  let isTableInitialized = false;
  let initializationPromise = null;

  async function initializeWorkRequestsTable() {
    if (isTableInitialized) return;
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
      let client;
      try {
        client = await db.connect();

        // Check if table AND required columns are present
        const check = await client.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'work_requests'
            AND column_name = ANY($1::text[])
        `, [REQUIRED_WORK_REQUESTS_COLUMNS]).catch(() => ({ rows: [] }));

        if (check.rows && check.rows.length >= REQUIRED_WORK_REQUESTS_COLUMNS.length) {
          // Schema verified complete
          isTableInitialized = true;
          return;
        }

        // Fallback for test or local standalone environments without master initialization
        await client.query(`
          CREATE TABLE IF NOT EXISTS work_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            company_id TEXT,
            request_type VARCHAR(100) NOT NULL,
            category VARCHAR(50) DEFAULT 'jobs',
            urgency VARCHAR(20) DEFAULT 'normal',
            status VARCHAR(20) DEFAULT 'pending',
            submitted_by_id TEXT,
            submitted_by_name VARCHAR(255),
            submitted_by_role VARCHAR(50),
            job_id TEXT,
            invoice_id TEXT,
            material_request_id TEXT,
            leave_request_id TEXT,
            title VARCHAR(255) NOT NULL,
            reason TEXT,
            response_notes TEXT,
            owner_response TEXT,
            actioned_by_id TEXT,
            actioned_by_name VARCHAR(255),
            actioned_at TIMESTAMP WITH TIME ZONE,
            resolved_by_id TEXT,
            resolved_by_name VARCHAR(255),
            resolved_at TIMESTAMP WITH TIME ZONE,
            evidence_urls JSONB DEFAULT '[]'::jsonb,
            payload JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );
        `).catch((err) => {
          warn('ensureWorkRequestsTable base table note: ' + err.message);
        });

        const safeAlterColumns = [
          'ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS owner_response TEXT;',
          'ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS response_notes TEXT;',
          'ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS actioned_by_id TEXT;',
          'ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS actioned_by_name VARCHAR(255);',
          'ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS actioned_at TIMESTAMP WITH TIME ZONE;',
          'ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS resolved_by_id TEXT;',
          'ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS resolved_by_name VARCHAR(255);',
          'ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP WITH TIME ZONE;',
          'CREATE INDEX IF NOT EXISTS idx_work_requests_company ON work_requests(company_id);',
          'CREATE INDEX IF NOT EXISTS idx_work_requests_status ON work_requests(status);',
          'CREATE INDEX IF NOT EXISTS idx_work_requests_job ON work_requests(job_id);',
        ];

        for (const sql of safeAlterColumns) {
          try {
            await client.query(sql);
          } catch (err) {
            if (['42701', '42P07'].includes(err?.code)) continue;
            if (err?.code === '42501' || /must be owner of table/i.test(err?.message || '')) {
              // Master process already applies table-owner schema migrations.
              // Workers running under application role should never crash on DDL.
              isTableInitialized = true;
              return;
            }
            warn('ensureWorkRequestsTable warning: ' + err.message);
          }
        }

        isTableInitialized = true;
      } catch (err) {
        warn('ensureWorkRequestsTable failed: ' + err.message);
      } finally {
        if (client) client.release();
        initializationPromise = null;
      }
    })();

    return initializationPromise;
  }

  return initializeWorkRequestsTable;
}

module.exports = {
  createWorkRequestsTableInitializer,
  ensureWorkRequestsSchemaOwner,
  REQUIRED_WORK_REQUESTS_COLUMNS,
};
