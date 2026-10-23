const crypto = require('crypto');
const { assertCanonicalPlans, assertSubscriptionSchema, assertSupportPolicyRows } = require('../scripts/subscriptionMigrationChecks');

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

const TIERED_SUPPORT_ENTITLEMENTS = {
  id: '038_tiered_support_entitlements',
  file: '038_tiered_support_entitlements.sql',
};

const INVOICE_PAYMENT_IDEMPOTENCY = {
  id: '039_invoice_payment_idempotency',
  file: '039_invoice_payment_idempotency.sql',
};

const SUPERADMIN_ANNOUNCEMENTS_SETTINGS = {
  id: '041_superadmin_announcements_and_system_settings',
  file: '041_superadmin_announcements_and_system_settings.sql',
};

const STAFF_PASSWORD_RESET_OTP_SCOPE = {
  id: '042_staff_password_reset_otp_scope',
  file: '042_staff_password_reset_otp_scope.sql',
};

const SECURITY_INFRASTRUCTURE_HARDENING_AND_RLS = {
  id: '043_security_infrastructure_hardening_and_rls',
  file: '043_security_infrastructure_hardening_and_rls.sql',
  tables: ['security_events', 'security_incidents', 'security_actions'],
};

const AI_RAG_PERSISTENT_CONVERSATIONS = {
  id: '044_ai_rag_persistent_conversations',
  file: '044_ai_rag_persistent_conversations.sql',
  tables: ['ai_documents', 'ai_document_chunks', 'ai_conversations', 'ai_conversation_messages'],
  indexes: [
    'idx_ai_documents_company_uploader_status', 'idx_ai_documents_company_hash',
    'idx_ai_documents_ingest_request', 'idx_ai_documents_family_latest',
    'idx_ai_document_chunks_search', 'idx_ai_document_chunks_company_document',
    'idx_ai_conversations_owner_recent', 'idx_ai_conversations_create_request_key',
    'idx_ai_conversation_messages_order', 'idx_ai_conversation_messages_user_request_key',
  ],
  policies: [
    'ai_documents_owner_scope', 'ai_document_chunks_owner_scope',
    'ai_conversations_owner_scope', 'ai_conversation_messages_owner_scope',
  ],
};

const FORWARD_MIGRATIONS = [
  PRODUCTION_DISPATCH, PRODUCTION_DISPATCH_PRIVILEGES, PRODUCTION_PACKING_WORKFLOW,
  CUSTOMER_MANUFACTURING_REQUESTS, SUBSCRIPTION_CATALOG_AND_STORAGE,
  TIERED_SUPPORT_ENTITLEMENTS, INVOICE_PAYMENT_IDEMPOTENCY, SUPERADMIN_ANNOUNCEMENTS_SETTINGS,
  STAFF_PASSWORD_RESET_OTP_SCOPE, SECURITY_INFRASTRUCTURE_HARDENING_AND_RLS,
  AI_RAG_PERSISTENT_CONVERSATIONS,
];

// Subscription migrations 037/038/039 and the newer 041/042/043 changes require
// an explicitly reviewed rollout. 038 depends on the controlled 037 ledger;
// 037 upserts plans and backfills storage; 039 changes payment idempotency;
// 041-044 schema, privilege, security, and AI persistence baselines have not been verified. Keep them
// allow-listed for controlled execution, but never apply them on startup.
const CONTROLLED_MIGRATION_IDS = new Set([
  SUBSCRIPTION_CATALOG_AND_STORAGE.id,
  TIERED_SUPPORT_ENTITLEMENTS.id,
  INVOICE_PAYMENT_IDEMPOTENCY.id,
  SUPERADMIN_ANNOUNCEMENTS_SETTINGS.id,
  STAFF_PASSWORD_RESET_OTP_SCOPE.id,
  SECURITY_INFRASTRUCTURE_HARDENING_AND_RLS.id,
  AI_RAG_PERSISTENT_CONVERSATIONS.id,
]);
const STARTUP_MIGRATIONS = FORWARD_MIGRATIONS.filter(
  migration => !CONTROLLED_MIGRATION_IDS.has(migration.id)
);

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

async function assertSuperAdminAnnouncementsSettingsSchema(client) {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p')
         AND c.relname=ANY(ARRAY['announcements','system_settings']::text[])) AS table_count,
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relforcerowsecurity
         AND c.relname=ANY(ARRAY['announcements','system_settings']::text[])) AS rls_count,
      (SELECT COUNT(*)::int FROM pg_policies
       WHERE schemaname='public' AND policyname=ANY(ARRAY[
         'smarterp_041_announcements_superadmin',
         'smarterp_041_announcements_company_read',
         'smarterp_041_announcements_company_insert',
         'smarterp_041_announcements_company_delete',
         'smarterp_041_system_settings_superadmin',
         'smarterp_041_maintenance_status_read'
       ]::text[])) AS policy_count,
      (SELECT COUNT(*)::int FROM pg_indexes
       WHERE schemaname='public' AND indexname=ANY(ARRAY[
         'idx_announcements_created_at','idx_notifications_idempotency'
       ]::text[])) AS index_count,
      (SELECT COUNT(*)::int FROM information_schema.columns
       WHERE table_schema='public' AND (
         (table_name='announcements' AND column_name=ANY(ARRAY['id','title','content','priority','created_by','created_at','company_id','target_role']::text[]))
         OR (table_name='system_settings' AND column_name=ANY(ARRAY['key','value','updated_at']::text[]))
         OR (table_name='notifications' AND column_name=ANY(ARRAY['data','idempotency_key']::text[]))
       )) AS column_count,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app' AND NOT rolsuper AND NOT rolbypassrls) AS app_role_safe,
      has_table_privilege('smarterp_app','public.announcements','SELECT') AS announcements_select,
      has_table_privilege('smarterp_app','public.announcements','INSERT') AS announcements_insert,
      has_table_privilege('smarterp_app','public.announcements','DELETE') AS announcements_delete,
      has_table_privilege('smarterp_app','public.announcements','UPDATE') AS announcements_update,
      has_table_privilege('smarterp_app','public.system_settings','SELECT') AS settings_select,
      has_table_privilege('smarterp_app','public.system_settings','INSERT') AS settings_insert,
      has_table_privilege('smarterp_app','public.system_settings','UPDATE') AS settings_update,
      has_sequence_privilege('smarterp_app','public.announcements_id_seq','USAGE') AS announcements_sequence_usage,
      (SELECT COUNT(*)::int FROM pg_roles r
       CROSS JOIN (VALUES ('announcements'),('system_settings')) AS t(table_name)
       WHERE r.rolname=ANY(ARRAY['anon','authenticated','service_role']::name[])
         AND (has_table_privilege(r.oid, 'public.' || quote_ident(t.table_name), 'SELECT')
           OR has_table_privilege(r.oid, 'public.' || quote_ident(t.table_name), 'INSERT')
           OR has_table_privilege(r.oid, 'public.' || quote_ident(t.table_name), 'UPDATE')
           OR has_table_privilege(r.oid, 'public.' || quote_ident(t.table_name), 'DELETE'))) AS external_role_privileges,
      (SELECT COUNT(*)::int FROM pg_roles r
       WHERE r.rolname=ANY(ARRAY['anon','authenticated','service_role']::name[])
         AND has_sequence_privilege(r.oid, 'public.announcements_id_seq', 'USAGE')) AS external_sequence_privileges
  `);
  const row = result.rows[0] || {};
  const expected = { table_count: 2, rls_count: 2, policy_count: 6, index_count: 2, column_count: 13, external_role_privileges: 0, external_sequence_privileges: 0 };
  const failures = Object.entries(expected)
    .filter(([key, value]) => Number(row[key]) !== value)
    .map(([key, value]) => `${key}: expected ${value}, got ${row[key] ?? 'missing'}`);
  if (!row.app_role_safe) failures.push('smarterp_app must exist without SUPERUSER or BYPASSRLS');
  for (const key of ['announcements_select','announcements_insert','announcements_delete','settings_select','settings_insert','settings_update','announcements_sequence_usage']) {
    if (!row[key]) failures.push(`application privilege ${key} is missing`);
  }
  if (row.announcements_update) failures.push('announcements UPDATE must not be granted to the application role');
  if (failures.length) throw new Error(`Super Admin schema verification failed: ${failures.join('; ')}`);
  return row;
}

async function inspectInvoicePaymentIdempotencySchema(client) {
  const result = await client.query(`
    SELECT
      to_regclass('public.invoice_payments') IS NOT NULL AS payment_table_exists,
      (SELECT COUNT(*)::int FROM information_schema.columns
       WHERE table_schema='public' AND table_name='invoice_payments'
         AND is_nullable='YES'
         AND (
           (column_name='idempotency_key' AND data_type='text') OR
           (column_name='request_fingerprint' AND data_type='character' AND character_maximum_length=64) OR
           (column_name='result_status' AND data_type='character varying' AND character_maximum_length=30) OR
           (column_name IN ('result_amount_paid','result_amount_due') AND data_type='numeric'
             AND numeric_precision=15 AND numeric_scale=2)
         )) AS nullable_columns,
      EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class ix ON ix.oid=i.indexrelid
        JOIN pg_class tbl ON tbl.oid=i.indrelid
        JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
        WHERE ns.nspname='public' AND tbl.relname='invoice_payments'
          AND ix.relname='idx_invoice_payments_company_idempotency'
          AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL
          AND pg_get_indexdef(i.indexrelid, 1, true)='company_id'
          AND pg_get_indexdef(i.indexrelid, 2, true)='idempotency_key'
          AND regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid)), '[()[:space:]]', '', 'g')
              = 'idempotency_keyisnotnull'
      ) AS company_unique_partial_index,
      (SELECT pg_get_constraintdef(c.oid, true)
       FROM pg_constraint c
       WHERE c.conrelid=to_regclass('public.invoice_payments')
         AND c.conname='invoice_payments_idempotency_result_check'
         AND c.contype='c'
       LIMIT 1) AS result_check_definition
  `);
  return result.rows[0] || {};
}

async function assertInvoicePaymentIdempotencySchema(client) {
  const row = await inspectInvoicePaymentIdempotencySchema(client);
  const failures = [];
  if (!row.payment_table_exists) failures.push('invoice_payments table is missing');
  if (Number(row.nullable_columns) !== 5) failures.push('all five nullable idempotency columns must exist');
  if (!row.company_unique_partial_index) failures.push('company-scoped unique partial idempotency index is missing or has an unexpected definition');

  const definition = String(row.result_check_definition || '').toLowerCase().replace(/"/g, '');
  const compact = definition.replace(/[()\s]/g, '');
  const requiredTerms = [
    'idempotency_keyisnull', 'request_fingerprintisnull', 'result_statusisnull',
    'result_amount_paidisnull', 'result_amount_dueisnull', 'idempotency_keyisnotnull',
    'lengthidempotency_key', 'request_fingerprint', 'result_status',
    'result_amount_paid', 'result_amount_due',
  ];
  if (!definition || requiredTerms.some(term => !compact.includes(term))) {
    failures.push('idempotency result check constraint is missing required null-state and result fields');
  }
  const boundedKeyLength = compact.includes('lengthidempotency_keybetween8and128') ||
    (compact.includes('lengthidempotency_key>=8') && compact.includes('lengthidempotency_key<=128'));
  if (!boundedKeyLength) failures.push('idempotency key length bounds are missing');
  if (!compact.includes('lengthrequest_fingerprint=64') && !compact.includes('char_lengthrequest_fingerprint=64')) {
    failures.push('request fingerprint length check is missing');
  }
  if (!compact.includes('or') || !compact.includes('and')) failures.push('idempotency result check is not a two-state constraint');
  if (failures.length) throw new Error(`Invoice payment idempotency schema verification failed: ${failures.join('; ')}`);
  return row;
}

async function verifyMigration(client, migrationId) {
  if (![INVOICE_PAYMENT_IDEMPOTENCY.id, SUPERADMIN_ANNOUNCEMENTS_SETTINGS.id, STAFF_PASSWORD_RESET_OTP_SCOPE.id, AI_RAG_PERSISTENT_CONVERSATIONS.id].includes(migrationId)) {
    await assertProductionDispatchSchema(client);
  }
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
  if (migrationId === SUBSCRIPTION_CATALOG_AND_STORAGE.id) {
    const supportPolicyColumn = await client.query(`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='plans' AND column_name='support_policy') AS present
    `);
    const supportPolicySelection = supportPolicyColumn.rows[0]?.present ? ', support_policy' : '';
    const plans = await client.query(
      `SELECT id, name, price_monthly, price_yearly, employee_limit,
              max_active_jobs, max_inventory_items, max_storage_bytes,
              max_material_requests, messages_history_days, features${supportPolicySelection}
         FROM plans WHERE id IN (1,2,3) ORDER BY id`
    );
    assertCanonicalPlans(plans.rows);
    await assertSubscriptionSchema(client);
  }
  if (migrationId === TIERED_SUPPORT_ENTITLEMENTS.id) {
    const plans = await client.query(
      `SELECT id, features, support_policy FROM plans WHERE id IN (1,2,3) ORDER BY id`
    );
    assertSupportPolicyRows(plans.rows);
    const schema = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema='public' AND table_name='feedback'
            AND column_name=ANY($1::text[])) AS feedback_columns,
        (SELECT COUNT(*)::int FROM pg_indexes
          WHERE schemaname='public' AND indexname=ANY($2::text[])) AS support_indexes,
        (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema='public' AND table_name='plans' AND column_name='support_policy') AS plan_policy_column
    `, [
      ['company_id','support_plan_id','support_channel','support_first_response_business_hours','support_first_response_due_at','support_first_responded_at'],
      ['idx_feedback_support_company_created','idx_feedback_support_response_due'],
    ]);
    if (schema.rows[0]?.feedback_columns !== 6 || schema.rows[0]?.support_indexes !== 2 || schema.rows[0]?.plan_policy_column !== 1) {
      throw new Error('Tiered support schema verification failed.');
    }
  }
  if (migrationId === SUPERADMIN_ANNOUNCEMENTS_SETTINGS.id) {
    await assertSuperAdminAnnouncementsSettingsSchema(client);
  }
  if (migrationId === INVOICE_PAYMENT_IDEMPOTENCY.id) {
    await assertInvoicePaymentIdempotencySchema(client);
  }
  if (migrationId === STAFF_PASSWORD_RESET_OTP_SCOPE.id) {
    const schema = await client.query(`
      SELECT
        (SELECT data_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name='email_otps' AND column_name='otp_code') AS otp_code_type,
        (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema='public' AND table_name='email_otps'
            AND column_name='purpose' AND is_nullable='NO') AS purpose_column,
        (SELECT COUNT(*)::int FROM pg_indexes
          WHERE schemaname='public' AND indexname='idx_email_otps_staff_purpose_lookup') AS purpose_index
    `);
    const row = schema.rows[0] || {};
    if (row.otp_code_type !== 'text' || row.purpose_column !== 1 || row.purpose_index !== 1) {
      throw new Error('Staff password-reset OTP schema verification failed.');
    }
  }
  if (migrationId === AI_RAG_PERSISTENT_CONVERSATIONS.id) {
    await assertAiRagPersistentConversationsSchema(client);
  }
}

async function assertAiRagPersistentConversationsSchema(client) {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[])) AS table_count,
      (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relforcerowsecurity
          AND c.relname=ANY($1::text[])) AS forced_rls_count,
      (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($2::text[])) AS index_count,
      (SELECT COUNT(*)::int FROM pg_policies WHERE schemaname='public' AND policyname=ANY($3::text[])) AS policy_count,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app' AND NOT rolsuper AND NOT rolbypassrls) AS app_role_safe,
      (SELECT COUNT(*)::int FROM (VALUES
        ('ai_documents', TRUE, FALSE),
        ('ai_document_chunks', FALSE, TRUE),
        ('ai_conversations', TRUE, FALSE),
        ('ai_conversation_messages', TRUE, FALSE)
      ) AS expected(table_name, can_update, can_delete)
       WHERE has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'SELECT')
         AND has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'INSERT')
         AND has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'UPDATE')=expected.can_update
         AND has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'DELETE')=expected.can_delete) AS app_grant_count,
      (SELECT COUNT(*)::int FROM (VALUES
        ('ai_documents', TRUE, TRUE, TRUE, FALSE),
        ('ai_document_chunks', TRUE, TRUE, FALSE, TRUE),
        ('ai_conversations', TRUE, TRUE, TRUE, FALSE),
        ('ai_conversation_messages', TRUE, TRUE, TRUE, FALSE)
      ) AS expected(table_name, can_select, can_insert, can_update, can_delete)
       WHERE has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'SELECT')<>expected.can_select
          OR has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'INSERT')<>expected.can_insert
          OR has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'UPDATE')<>expected.can_update
          OR has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'DELETE')<>expected.can_delete
          OR has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'TRUNCATE')
          OR has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'REFERENCES')
          OR has_table_privilege('smarterp_app','public.' || quote_ident(expected.table_name),'TRIGGER')) AS app_unexpected_privilege_count,
      (SELECT COUNT(*)::int FROM unnest($1::text[]) AS t(table_name)
       WHERE has_table_privilege('smarterp_app','public.' || quote_ident(t.table_name),'TRUNCATE')) AS app_truncate_count,
      (SELECT COUNT(*)::int FROM unnest(ARRAY['anon','authenticated','service_role']::text[]) AS r(role_name)
       CROSS JOIN unnest($1::text[]) AS t(table_name)
       WHERE has_table_privilege(r.role_name,'public.' || quote_ident(t.table_name),'SELECT')
          OR has_table_privilege(r.role_name,'public.' || quote_ident(t.table_name),'INSERT')
          OR has_table_privilege(r.role_name,'public.' || quote_ident(t.table_name),'UPDATE')
          OR has_table_privilege(r.role_name,'public.' || quote_ident(t.table_name),'DELETE')
          OR has_table_privilege(r.role_name,'public.' || quote_ident(t.table_name),'TRUNCATE')) AS browser_role_privilege_count
  `, [
    AI_RAG_PERSISTENT_CONVERSATIONS.tables,
    AI_RAG_PERSISTENT_CONVERSATIONS.indexes,
    AI_RAG_PERSISTENT_CONVERSATIONS.policies,
  ]);
  const row = result.rows[0] || {};
  const expected = {
    table_count: 4,
    forced_rls_count: 4,
    index_count: 10,
    policy_count: 4,
    app_grant_count: 4,
    app_unexpected_privilege_count: 0,
    app_truncate_count: 0,
    browser_role_privilege_count: 0,
  };
  const failures = Object.entries(expected)
    .filter(([key, value]) => Number(row[key]) !== value)
    .map(([key, value]) => `${key}: expected ${value}, got ${row[key] ?? 'missing'}`);
  if (!row.app_role_safe) failures.push('smarterp_app must exist without SUPERUSER or BYPASSRLS');
  if (failures.length) throw new Error(`AI RAG/conversation schema verification failed: ${failures.join('; ')}`);
  return row;
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

    if (migrationId === INVOICE_PAYMENT_IDEMPOTENCY.id) {
      const schema = await inspectInvoicePaymentIdempotencySchema(client);
      const hasAnyMigrationArtifacts = Number(schema.nullable_columns || 0) > 0 ||
        Boolean(schema.company_unique_partial_index) || Boolean(schema.result_check_definition);
      if (hasAnyMigrationArtifacts) {
        // Existing objects without a ledger entry are adopted only after the
        // complete postcondition check. Partial/drifted objects are never
        // repaired by replaying CREATE IF NOT EXISTS migration SQL.
        await assertInvoicePaymentIdempotencySchema(client);
        await client.query(
          'INSERT INTO app_migration_history (migration_id, checksum_sha256) VALUES ($1, $2)',
          [migrationId, checksum]
        );
        await client.query('COMMIT');
        inTransaction = false;
        return { migrationId, status: 'adopted_verified_schema', checksum };
      }
      if (!schema.payment_table_exists) {
        throw new Error('Migration 039 requires the existing invoice_payments base table; refusing to create or infer a financial schema.');
      }
    }

    if (migrationId === TIERED_SUPPORT_ENTITLEMENTS.id) {
      const prerequisite = await client.query(
        'SELECT 1 FROM app_migration_history WHERE migration_id = $1',
        [SUBSCRIPTION_CATALOG_AND_STORAGE.id]
      );
      if (!prerequisite.rows.length) {
        throw new Error('Tiered support entitlements require recorded migration 037; refusing to apply 038 before subscription catalog provisioning.');
      }
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
    } else if (![INVOICE_PAYMENT_IDEMPOTENCY.id, SUPERADMIN_ANNOUNCEMENTS_SETTINGS.id, STAFF_PASSWORD_RESET_OTP_SCOPE.id].includes(migrationId)) {
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
  TIERED_SUPPORT_ENTITLEMENTS,
  INVOICE_PAYMENT_IDEMPOTENCY,
  SUPERADMIN_ANNOUNCEMENTS_SETTINGS,
  STAFF_PASSWORD_RESET_OTP_SCOPE,
  AI_RAG_PERSISTENT_CONVERSATIONS,
  FORWARD_MIGRATIONS,
  STARTUP_MIGRATIONS,
  stripOuterTransaction,
  migrationChecksum,
  assertProductionDispatchSchema,
  assertProductionDispatchPrivileges,
  assertProductionPackingWorkflowSchema,
  assertCustomerManufacturingRequestSchema,
  assertSuperAdminAnnouncementsSettingsSchema,
  assertAiRagPersistentConversationsSchema,
  inspectInvoicePaymentIdempotencySchema,
  assertInvoicePaymentIdempotencySchema,
  applyForwardMigration,
};
