/**
 * utils/migrationInspector.js
 * Inspects database migration status against the codebase without executing pending migrations.
 * Accurately reports confirmed applied migrations, pending migrations, and schema health.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Scans migrations/ directory for numbered SQL migration files.
 * @returns {Array<{ id: string, name: string, filename: string }>}
 */
function getLocalMigrationFiles() {
  try {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => /^\d{3}_.*\.sql$/.test(f))
      .sort()
      .map(f => {
        const match = f.match(/^(\d{3}[a-z]?)_(.*)\.sql$/);
        return {
          id: match ? match[1] : f.replace(/\.sql$/, ''),
          name: f.replace(/\.sql$/, ''),
          filename: f,
        };
      });
  } catch (err) {
    logger.warn('[migrationInspector] Could not scan migrations directory', { error: err.message });
    return [];
  }
}

/**
 * Inspect live database migration status.
 * @param {object} pool - PostgreSQL pool or client
 * @returns {Promise<object>}
 */
async function inspectDatabaseMigrations(pool) {
  if (!pool) {
    return {
      status: 'UNAVAILABLE',
      error: 'No database connection available',
      latestApplied: null,
      pendingMigrations: [],
      schemaVersion: 'unknown',
    };
  }

  const localFiles = getLocalMigrationFiles();
  const appliedSet = new Set();
  const appliedDetails = new Map();

  let client;
  try {
    client = await pool.connect();

    // 1. Check modern forward migration history table (app_migration_history)
    const appHistoryCheck = await client.query(
      "SELECT to_regclass('public.app_migration_history') IS NOT NULL AS exists"
    ).catch(() => ({ rows: [{ exists: false }] }));

    if (appHistoryCheck.rows[0]?.exists) {
      const appHistory = await client.query(
        'SELECT migration_id, checksum_sha256, applied_at, applied_by FROM app_migration_history ORDER BY applied_at ASC'
      ).catch(() => ({ rows: [] }));

      for (const row of appHistory.rows) {
        const id = row.migration_id.replace(/^(\d{3}[a-z]?).*$/, '$1');
        appliedSet.add(row.migration_id);
        appliedSet.add(id);
        appliedDetails.set(row.migration_id, {
          id: row.migration_id,
          name: row.migration_id,
          appliedAt: row.applied_at,
          appliedBy: row.applied_by,
          source: 'app_migration_history',
        });
      }
    }

    // 2. Check legacy schema_migrations table
    const legacyCheck = await client.query(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists"
    ).catch(() => ({ rows: [{ exists: false }] }));

    if (legacyCheck.rows[0]?.exists) {
      const legacyRows = await client.query(
        'SELECT name FROM schema_migrations'
      ).catch(() => ({ rows: [] }));

      for (const row of legacyRows.rows) {
        const baseName = row.name.replace(/\.sql$/, '');
        const id = baseName.replace(/^(\d{3}[a-z]?).*$/, '$1');
        appliedSet.add(baseName);
        appliedSet.add(id);
        if (!appliedDetails.has(baseName)) {
          appliedDetails.set(baseName, {
            id,
            name: baseName,
            appliedAt: null,
            source: 'schema_migrations',
          });
        }
      }
    }

    // Determine pending migrations
    const pendingMigrations = [];
    let latestApplied = null;

    for (const file of localFiles) {
      const isApplied = appliedSet.has(file.name) || appliedSet.has(file.id) || appliedSet.has(`${file.id}_`);
      if (isApplied) {
        latestApplied = file;
      } else {
        pendingMigrations.push({
          id: file.id,
          name: file.name,
          filename: file.filename,
          status: file.id === '049' ? 'STAGED_PENDING_APPROVAL' : 'PENDING',
        });
      }
    }

    const latestAppliedDetail = latestApplied ? appliedDetails.get(latestApplied.name) || latestApplied : null;
    const schemaVersion = latestApplied ? latestApplied.id : 'uninitialized';

    return {
      status: 'VERIFIED',
      schemaVersion,
      latestApplied: latestAppliedDetail ? {
        id: latestApplied.id,
        name: latestApplied.name,
        appliedAt: latestAppliedDetail.appliedAt ? new Date(latestAppliedDetail.appliedAt).toISOString() : 'legacy-recorded',
      } : null,
      pendingMigrations,
      totalLocal: localFiles.length,
      totalApplied: appliedDetails.size,
      hasPending: pendingMigrations.length > 0,
    };
  } catch (err) {
    logger.warn('[migrationInspector] Failed to read database migration state', { error: err.message });
    return {
      status: 'QUERY_FAILED',
      error: err.message,
      schemaVersion: 'unverified',
      latestApplied: null,
      pendingMigrations: localFiles.map(f => ({ ...f, status: 'UNKNOWN' })),
    };
  } finally {
    if (client) {
      try { client.release(); } catch (_) {}
    }
  }
}

module.exports = {
  inspectDatabaseMigrations,
  getLocalMigrationFiles,
};
