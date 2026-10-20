const crypto = require('crypto');

const PRODUCTION_DISPATCH = {
  id: '033_production_dispatch',
  file: '033_production_dispatch.sql',
  tables: [
    'production_sequences', 'production_orders', 'production_batches', 'production_reports',
    'production_order_materials', 'production_inspections', 'production_dispatches',
    'production_dispatch_adjustments', 'production_events', 'production_idempotency',
  ],
  indexes: [
    'idx_production_orders_company_status_due', 'idx_production_orders_company_customer',
    'idx_production_orders_company_part', 'idx_production_orders_assignee',
    'idx_production_batches_order', 'idx_production_batches_one_active_order',
    'idx_production_reports_order_batch', 'idx_production_inspections_order_batch',
    'idx_production_dispatches_order', 'idx_production_events_order',
    'idx_production_materials_order',
  ],
  triggers: [
    'production_reports_append_only', 'production_inspections_append_only',
    'production_dispatches_append_only', 'production_dispatch_adjustments_append_only',
    'production_events_append_only',
  ],
};

const PRODUCTION_DISPATCH_PRIVILEGES = {
  id: '034_production_dispatch_privileges',
  file: '034_production_dispatch_privileges.sql',
};

const PRODUCTION_PACKING_WORKFLOW = {
  id: '035_production_packing_workflow',
  file: '035_production_packing_workflow.sql',
};

const CUSTOMER_MANUFACTURING_REQUESTS = {
  id: '036_customer_manufacturing_requests',
  file: '036_customer_manufacturing_requests.sql',
  tables: [
    'customer_manufacturing_requests', 'customer_manufacturing_request_events',
    'customer_manufacturing_production_links', 'production_order_invoice_links',
  ],
  indexes: [
    'idx_mfg_requests_company_status_created', 'idx_mfg_requests_customer_created',
    'idx_mfg_events_request_created', 'idx_mfg_production_link_order',
    'idx_production_invoice_link_order', 'idx_production_invoice_link_invoice',
  ],
};

const SUBSCRIPTION_CATALOG_AND_STORAGE = {
  id: '037_subscription_catalog_and_storage',
  file: '037_subscription_catalog_and_storage.sql',
};

const FORWARD_MIGRATIONS = [
  PRODUCTION_DISPATCH, PRODUCTION_DISPATCH_PRIVILEGES, PRODUCTION_PACKING_WORKFLOW,
  CUSTOMER_MANUFACTURING_REQUESTS, SUBSCRIPTION_CATALOG_AND_STORAGE,
];

function stripOuterTransaction(sql) {
  return sql
    .replace(/^\s*BEGIN\s*;\s*$/im, '')
    .replace(/^\s*COMMIT\s*;\s*$/im, '')
    .trim();
}

function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function assertProductionDispatchSchema(client) {
  const verification = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[])) AS table_count,
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relname=ANY($1::text[])) AS rls_count,
      (SELECT COUNT(*)::int FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1::text[])) AS policy_count,
      (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($2::text[])) AS index_count,
      (SELECT COUNT(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname=ANY($3::text[])) AS trigger_count,
      (SELECT COUNT(*)::int FROM pg_constraint
       WHERE connamespace='public'::regnamespace
         AND conrelid IN (SELECT oid FROM pg_class WHERE relname=ANY($1::text[]))) AS constraint_count,
      (SELECT COUNT(*)::int FROM pg_constraint
       WHERE connamespace='public'::regnamespace AND contype='f'
         AND conrelid IN (SELECT oid FROM pg_class WHERE relname=ANY($1::text[]))) AS foreign_key_count,
      to_regprocedure('public.production_reject_history_mutation()') IS NOT NULL AS history_function,
      to_regclass('public.production_packing_records') IS NOT NULL AS packing_workflow_installed,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app' AND NOT rolsuper AND NOT rolbypassrls) AS app_role_safe,
      has_schema_privilege('smarterp_app', 'public', 'USAGE') AS app_schema_usage,
      (SELECT COUNT(*)::int FROM unnest($1::text[]) AS t(name)
       WHERE has_table_privilege('smarterp_app', 'public.' || quote_ident(t.name), 'SELECT')
         AND has_table_privilege('smarterp_app', 'public.' || quote_ident(t.name), 'INSERT')) AS app_grant_count
  `, [PRODUCTION_DISPATCH.tables, PRODUCTION_DISPATCH.indexes, PRODUCTION_DISPATCH.triggers]);

  const row = verification.rows[0] || {};
  const expected = {
    table_count: PRODUCTION_DISPATCH.tables.length,
    rls_count: PRODUCTION_DISPATCH.tables.length,
    policy_count: PRODUCTION_DISPATCH.tables.length,
    index_count: PRODUCTION_DISPATCH.indexes.length,
    trigger_count: PRODUCTION_DISPATCH.triggers.length,
    constraint_count: row.packing_workflow_installed ? 59 : 57,
    foreign_key_count: row.packing_workflow_installed ? 24 : 22,
    app_grant_count: PRODUCTION_DISPATCH.tables.length,
  };
  const failures = Object.entries(expected)
    .filter(([key, value]) => Number(row[key]) !== value)
    .map(([key, value]) => `${key}: expected ${value}, got ${row[key] ?? 'missing'}`);
  if (!row.history_function) failures.push('append-only trigger function is missing');
  if (!row.app_role_safe) failures.push('smarterp_app must exist without superuser or BYPASSRLS privileges');
  if (!row.app_schema_usage) failures.push('smarterp_app lacks public schema USAGE');
  if (failures.length) throw new Error(`Production & Dispatch schema verification failed: ${failures.join('; ')}`);
  return row;
}

async function assertProductionPackingWorkflowSchema(client) {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname='production_packing_records') AS table_count,
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='production_packing_records' AND c.relrowsecurity) AS rls_count,
      (SELECT COUNT(*)::int FROM pg_policies WHERE schemaname='public' AND tablename='production_packing_records') AS policy_count,
      (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1::text[])) AS index_count,
      (SELECT COUNT(*)::int FROM pg_constraint
       WHERE connamespace='public'::regnamespace AND conrelid='public.production_packing_records'::regclass) AS packing_constraint_count,
      (SELECT COUNT(*)::int FROM pg_constraint
       WHERE connamespace='public'::regnamespace AND contype='f' AND conrelid='public.production_packing_records'::regclass) AS packing_foreign_key_count,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.production_orders'::regclass AND conname='production_orders_dispatch_employee_fk') AS dispatch_employee_fk,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.production_dispatches'::regclass AND conname='production_dispatches_packing_record_fk') AS dispatch_packing_fk,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='production_orders' AND column_name='dispatch_employee_id') AS dispatch_employee_column,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='production_dispatches' AND column_name='packing_record_id') AS dispatch_packing_column,
      has_table_privilege('smarterp_app','public.production_packing_records','SELECT') AS app_select,
      has_table_privilege('smarterp_app','public.production_packing_records','INSERT') AS app_insert,
      has_table_privilege('smarterp_app','public.production_packing_records','UPDATE') AS app_update,
      has_table_privilege('smarterp_app','public.production_packing_records','DELETE') OR
        has_table_privilege('smarterp_app','public.production_packing_records','TRUNCATE') AS app_destructive_privilege,
      (SELECT COUNT(*)::int FROM unnest(ARRAY['anon','authenticated','service_role']::text[]) AS r(role_name)
       WHERE has_table_privilege(r.role_name,'public.production_packing_records','SELECT') OR
             has_table_privilege(r.role_name,'public.production_packing_records','INSERT') OR
             has_table_privilege(r.role_name,'public.production_packing_records','UPDATE') OR
             has_table_privilege(r.role_name,'public.production_packing_records','DELETE') OR
             has_table_privilege(r.role_name,'public.production_packing_records','TRUNCATE')) AS external_privilege_count
  `, [['idx_production_orders_dispatch_employee','idx_production_packing_order','idx_production_packing_inspection','idx_production_dispatches_packing']]);
  const row = result.rows[0] || {};
  const expected = {
    table_count: 1,
    rls_count: 1,
    policy_count: 1,
    index_count: 4,
    packing_constraint_count: 7,
    packing_foreign_key_count: 3,
    external_privilege_count: 0,
  };
  const failures = Object.entries(expected)
    .filter(([key, value]) => Number(row[key]) !== value)
    .map(([key, value]) => `${key}: expected ${value}, got ${row[key] ?? 'missing'}`);
  for (const key of ['dispatch_employee_fk','dispatch_packing_fk','dispatch_employee_column','dispatch_packing_column','app_select','app_insert','app_update']) {
    if (!row[key]) failures.push(`${key} is missing`);
  }
  if (row.app_destructive_privilege) failures.push('smarterp_app has DELETE or TRUNCATE on packing records');
  if (failures.length) throw new Error(`Production packing workflow schema verification failed: ${failures.join('; ')}`);
  return row;
}

async function assertProductionDispatchPrivileges(client) {
  const updateTables = ['production_sequences', 'production_orders', 'production_batches'];
  const insertOnlyTables = PRODUCTION_DISPATCH.tables.filter(name => !updateTables.includes(name));
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM unnest($1::text[]) AS t(name)
       WHERE has_table_privilege('smarterp_app','public.' || quote_ident(t.name), 'SELECT')
         AND has_table_privilege('smarterp_app','public.' || quote_ident(t.name), 'INSERT')) AS app_read_insert_count,
      (SELECT COUNT(*)::int FROM unnest($2::text[]) AS t(name)
       WHERE has_table_privilege('smarterp_app','public.' || quote_ident(t.name), 'UPDATE')) AS app_update_count,
      (SELECT COUNT(*)::int FROM unnest($3::text[]) AS t(name)
       WHERE has_table_privilege('smarterp_app','public.' || quote_ident(t.name), 'UPDATE')) AS unexpected_app_update_count,
      (SELECT COUNT(*)::int FROM unnest($1::text[]) AS t(name)
       WHERE has_table_privilege('smarterp_app','public.' || quote_ident(t.name), 'DELETE')
          OR has_table_privilege('smarterp_app','public.' || quote_ident(t.name), 'TRUNCATE')
          OR has_table_privilege('smarterp_app','public.' || quote_ident(t.name), 'REFERENCES')
          OR has_table_privilege('smarterp_app','public.' || quote_ident(t.name), 'TRIGGER')
          OR has_table_privilege('smarterp_app','public.' || quote_ident(t.name), 'MAINTAIN')) AS unexpected_app_privilege_count,
      (SELECT COUNT(*)::int FROM unnest($4::text[]) AS r(role_name) CROSS JOIN unnest($1::text[]) AS t(table_name)
       WHERE has_table_privilege(r.role_name, 'public.' || quote_ident(t.table_name), 'SELECT')
          OR has_table_privilege(r.role_name, 'public.' || quote_ident(t.table_name), 'INSERT')
          OR has_table_privilege(r.role_name, 'public.' || quote_ident(t.table_name), 'UPDATE')
          OR has_table_privilege(r.role_name, 'public.' || quote_ident(t.table_name), 'DELETE')
          OR has_table_privilege(r.role_name, 'public.' || quote_ident(t.table_name), 'TRUNCATE')
          OR has_table_privilege(r.role_name, 'public.' || quote_ident(t.table_name), 'REFERENCES')
          OR has_table_privilege(r.role_name, 'public.' || quote_ident(t.table_name), 'TRIGGER')
          OR has_table_privilege(r.role_name, 'public.' || quote_ident(t.table_name), 'MAINTAIN')) AS external_role_privilege_count,
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
       WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND acl.grantee=0) AS public_acl_count
  `, [PRODUCTION_DISPATCH.tables, updateTables, insertOnlyTables, ['anon', 'authenticated', 'service_role']]);
  const row = result.rows[0] || {};
  const expected = {
    app_read_insert_count: PRODUCTION_DISPATCH.tables.length,
    app_update_count: updateTables.length,
    unexpected_app_update_count: 0,
    unexpected_app_privilege_count: 0,
    external_role_privilege_count: 0,
    public_acl_count: 0,
  };
  const failures = Object.entries(expected)
    .filter(([key, value]) => Number(row[key]) !== value)
    .map(([key, value]) => `${key}: expected ${value}, got ${row[key] ?? 'missing'}`);
  if (failures.length) throw new Error(`Production & Dispatch privilege verification failed: ${failures.join('; ')}`);
  return row;
}

async function assertCustomerManufacturingRequestSchema(client) {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[])) AS table_count,
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relname=ANY($1::text[])) AS rls_count,
      (SELECT COUNT(*)::int FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1::text[])) AS policy_count,
      (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($2::text[])) AS index_count,
      (SELECT COUNT(*)::int FROM unnest($1::text[]) AS t(name)
       WHERE has_table_privilege('smarterp_app','public.' || quote_ident(t.name),'SELECT')
         AND has_table_privilege('smarterp_app','public.' || quote_ident(t.name),'INSERT')) AS app_read_insert_count,
      has_table_privilege('smarterp_app','public.customer_manufacturing_requests','UPDATE') AS request_update,
      has_table_privilege('smarterp_app','public.customer_manufacturing_request_events','UPDATE') AS event_update,
      has_table_privilege('smarterp_app','public.customer_manufacturing_request_events','DELETE') AS event_delete,
      has_table_privilege('smarterp_app','public.customer_manufacturing_production_links','UPDATE') AS production_link_update,
      has_table_privilege('smarterp_app','public.production_order_invoice_links','UPDATE') AS invoice_link_update
  `, [CUSTOMER_MANUFACTURING_REQUESTS.tables, CUSTOMER_MANUFACTURING_REQUESTS.indexes]);
  const row = result.rows[0] || {};
  const expected = { table_count: 4, rls_count: 4, policy_count: 4, index_count: 6, app_read_insert_count: 4 };
  const failures = Object.entries(expected)
    .filter(([key, value]) => Number(row[key]) !== value)
    .map(([key, value]) => `${key}: expected ${value}, got ${row[key] ?? 'missing'}`);
  if (!row.request_update) failures.push('application request update permission is missing');
  for (const key of ['event_update','event_delete','production_link_update','invoice_link_update']) {
    if (row[key]) failures.push(`${key} must not be granted to the application role`);
  }
  if (failures.length) throw new Error(`Customer manufacturing request schema verification failed: ${failures.join('; ')}`);
  return row;
}

async function verifyMigration(client, migrationId) {
  await assertProductionDispatchSchema(client);
  if (migrationId === PRODUCTION_DISPATCH_PRIVILEGES.id) {
    await assertProductionDispatchPrivileges(client);
  }
  if (migrationId === PRODUCTION_PACKING_WORKFLOW.id) {
    await assertProductionPackingWorkflowSchema(client);
  }
  if (migrationId === CUSTOMER_MANUFACTURING_REQUESTS.id) {
    await assertProductionPackingWorkflowSchema(client);
    await assertCustomerManufacturingRequestSchema(client);
  }
}

async function applyForwardMigration(client, { migrationId, sql }) {
  const migration = FORWARD_MIGRATIONS.find(item => item.id === migrationId);
  if (!migration) {
    throw new Error(`Migration ${migrationId} is not in the reviewed forward-migration allow-list.`);
  }
  const checksum = migrationChecksum(sql);
  let inTransaction = false;

  try {
    await client.query('BEGIN');
    inTransaction = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      'smarterp:forward-migration', migrationId,
    ]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_migration_history (
        migration_id TEXT PRIMARY KEY,
        checksum_sha256 CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        applied_by TEXT NOT NULL DEFAULT CURRENT_USER
      )
    `);

    const history = await client.query(
      'SELECT checksum_sha256 FROM app_migration_history WHERE migration_id = $1 FOR UPDATE',
      [migrationId]
    );
    if (history.rows.length) {
      if (String(history.rows[0].checksum_sha256).trim() !== checksum) {
        throw new Error(`Checksum mismatch for already-recorded migration ${migrationId}; refusing to rerun it.`);
      }
      await verifyMigration(client, migrationId);
      await client.query('COMMIT');
      inTransaction = false;
      return { migrationId, status: 'already_applied', checksum };
    }

    // Migration 033 was applied on some existing deployments through the legacy
    // ledger. Adopt it only when that record exists and the complete live schema
    // passes catalog verification; never rerun its DDL over untracked objects.
    const legacyLedger = await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists");
    let legacyApplied = false;
    if (legacyLedger.rows[0]?.exists) {
      const legacy = await client.query('SELECT name FROM schema_migrations WHERE name = $1', [`${migrationId}.sql`]);
      legacyApplied = legacy.rows.length > 0;
    }
    if (legacyApplied) {
      await verifyMigration(client, migrationId);
      await client.query(
        'INSERT INTO app_migration_history (migration_id, checksum_sha256) VALUES ($1, $2)',
        [migrationId, checksum]
      );
      await client.query('COMMIT');
      inTransaction = false;
      return { migrationId, status: 'adopted_verified_legacy_record', checksum };
    }

    if (migrationId === PRODUCTION_DISPATCH.id) {
      const preexisting = await client.query(`
        SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[])
        ORDER BY c.relname
      `, [PRODUCTION_DISPATCH.tables]);
      const preexistingFunction = await client.query(
        "SELECT to_regprocedure('public.production_reject_history_mutation()') IS NOT NULL AS exists"
      );
      if (preexisting.rows.length || preexistingFunction.rows[0]?.exists) {
        const names = preexisting.rows.map(row => row.name);
        if (preexistingFunction.rows[0]?.exists) names.push('production_reject_history_mutation()');
        throw new Error(`Untracked Production & Dispatch objects already exist (${names.join(', ')}); inspect and reconcile the migration ledger before proceeding.`);
      }
    } else {
      await assertProductionDispatchSchema(client);
    }

    await client.query(stripOuterTransaction(sql));
    await verifyMigration(client, migrationId);
    await client.query(
      'INSERT INTO app_migration_history (migration_id, checksum_sha256) VALUES ($1, $2)',
      [migrationId, checksum]
    );
    await client.query('COMMIT');
    inTransaction = false;
    return { migrationId, status: 'applied', checksum };
  } catch (error) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch (_) { /* preserve original migration error */ }
    }
    throw error;
  }
}

module.exports = {
  PRODUCTION_DISPATCH,
  PRODUCTION_DISPATCH_PRIVILEGES,
  PRODUCTION_PACKING_WORKFLOW,
  CUSTOMER_MANUFACTURING_REQUESTS,
  FORWARD_MIGRATIONS,
  stripOuterTransaction,
  migrationChecksum,
  assertProductionDispatchSchema,
  assertProductionDispatchPrivileges,
  assertProductionPackingWorkflowSchema,
  assertCustomerManufacturingRequestSchema,
  applyForwardMigration,
};
