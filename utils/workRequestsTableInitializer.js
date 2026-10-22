'use strict';

/**
 * Create the legacy work-request schema initializer with process-local
 * single-flight behavior. The database work remains idempotent; concurrent
 * routes share one initialization attempt.
 */
function createWorkRequestsTableInitializer({ db, warn = console.warn } = {}) {
  if (!db || typeof db.connect !== 'function') {
    throw new TypeError('A database pool with connect() is required.');
  }

  let isTableInitialized = false;
  let initializationPromise = null;

  async function initializeWorkRequestsTable() {
    let client;
    try {
      client = await db.connect();

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
        warn('ensureWorkRequestsTable base table note:', err.message);
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
          if (err?.code === '42501') {
            // Owner-controlled DDL cannot be repaired by the app role. Avoid
            // retrying on every request; a table owner must apply the changes.
            warn('ensureWorkRequestsTable: app role cannot alter the table; apply required schema changes with the table owner.');
            isTableInitialized = true;
            return;
          }
          warn('ensureWorkRequestsTable alter column warning:', err.message);
        }
      }

      isTableInitialized = true;
    } catch (err) {
      warn('ensureWorkRequestsTable initialization failed:', err.message);
    } finally {
      if (client) client.release();
    }
  }

  return function ensureWorkRequestsTable() {
    if (isTableInitialized) return Promise.resolve();
    if (initializationPromise) return initializationPromise;

    initializationPromise = initializeWorkRequestsTable().finally(() => {
      initializationPromise = null;
    });
    return initializationPromise;
  };
}

module.exports = { createWorkRequestsTableInitializer };
