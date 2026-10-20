'use strict';

const { SUBSCRIPTION_PLANS } = require('../services/subscriptionCatalog');
const { isDeepStrictEqual } = require('node:util');

const LEGACY_PLAN_NAMES = Object.freeze({
  1: ['starter', 'free'],
  2: ['professional', 'basic'],
  3: ['enterprise', 'pro'],
});

function fail(message) {
  throw new Error(message);
}

function databaseTargetParts(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch (_) {
    fail('A valid dedicated subscription test database URL is required.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    fail('Dedicated subscription test target must use PostgreSQL.');
  }
  return {
    host: url.hostname.toLowerCase(),
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    role: decodeURIComponent(url.username),
  };
}

function assertTargetConfiguration(env) {
  if (env.NODE_ENV === 'production' || env.SMARTERP_ENVIRONMENT !== 'isolated_test') {
    fail('Subscription migration requires SMARTERP_ENVIRONMENT=isolated_test outside production.');
  }
  const testUrl = env.SMARTERP_SUBSCRIPTION_TEST_DATABASE_URL;
  const appUrl = env.DATABASE_URL;
  const required = [
    env.SMARTERP_SUBSCRIPTION_TEST_DATABASE,
    env.SMARTERP_SUBSCRIPTION_TEST_DATABASE_HOST,
    env.SMARTERP_SUBSCRIPTION_TEST_DATABASE_PORT,
    env.SMARTERP_SUBSCRIPTION_TEST_DATABASE_ROLE,
    env.SMARTERP_SUBSCRIPTION_TEST_DATABASE_OID,
    env.SMARTERP_SUBSCRIPTION_TEST_ISOLATION_ID,
  ];
  if (!testUrl || !appUrl || required.some(value => !value)) {
    fail('Dedicated test URL, application URL, expected database identity, role, host, port, and isolation ID are required.');
  }

  const target = databaseTargetParts(testUrl);
  const app = databaseTargetParts(appUrl);
  if (target.host === app.host && target.port === app.port && target.database === app.database) {
    fail('Dedicated test database target resolves to the configured application database.');
  }
  if (target.host !== String(env.SMARTERP_SUBSCRIPTION_TEST_DATABASE_HOST).toLowerCase() ||
      target.port !== String(env.SMARTERP_SUBSCRIPTION_TEST_DATABASE_PORT) ||
      target.database !== env.SMARTERP_SUBSCRIPTION_TEST_DATABASE ||
      target.role !== env.SMARTERP_SUBSCRIPTION_TEST_DATABASE_ROLE) {
    fail('Dedicated test URL does not match its separately configured expected identity.');
  }
  if (target.database.toLowerCase() === 'postgres' || target.role.toLowerCase() === 'postgres') {
    fail('Refusing the default postgres database/role.');
  }
  return target;
}

function assertIsolatedTarget({ env, identity, role, marker }) {
  const target = assertTargetConfiguration(env);

  if (!identity || identity.database_name !== target.database ||
      identity.database_role !== target.role || identity.host !== target.host ||
      String(identity.port) !== target.port ||
      String(identity.database_oid) !== String(env.SMARTERP_SUBSCRIPTION_TEST_DATABASE_OID)) {
    fail('Connected PostgreSQL identity does not match the separately configured test target.');
  }
  if (role?.rolsuper !== false || role?.rolbypassrls !== false) {
    fail('Refusing the default postgres database/role or a privileged migration role.');
  }
  if (!marker || marker.environment !== 'isolated_test' ||
      marker.database_name !== target.database || marker.database_role !== target.role ||
      String(marker.database_oid) !== String(identity.database_oid) ||
      marker.isolation_id !== env.SMARTERP_SUBSCRIPTION_TEST_ISOLATION_ID) {
    fail('The DBA-provisioned isolated-test identity marker is missing or does not match.');
  }
  return true;
}

function assertLegacyPlanMapping(rows) {
  const byId = new Map(rows.map(row => [Number(row.id), String(row.name).trim().toLowerCase()]));
  for (const [idText, aliases] of Object.entries(LEGACY_PLAN_NAMES)) {
    const id = Number(idText);
    if (!aliases.includes(byId.get(id))) {
      fail(`Refusing to rewrite plan ${id}: expected a known legacy/canonical plan label for that stable ID.`);
    }
  }
  for (const [id, name] of byId) {
    const matchingCanonicalIds = Object.entries(LEGACY_PLAN_NAMES)
      .filter(([, aliases]) => aliases.includes(name))
      .map(([canonicalId]) => Number(canonicalId));
    if (matchingCanonicalIds.length && !matchingCanonicalIds.includes(id)) {
      fail(`Refusing ambiguous plan mapping: known plan label appears under unexpected ID ${id}.`);
    }
  }
  return true;
}

function assertCanonicalPlans(rows) {
  if (rows.length !== 3) fail('Provisioning verification failed: expected exactly three canonical plan rows (IDs 1–3).');
  for (const [idText, expected] of Object.entries(SUBSCRIPTION_PLANS)) {
    const row = rows.find(item => Number(item.id) === Number(idText));
    if (!row) fail(`Provisioning verification failed: canonical plan ID ${idText} is missing.`);
    const fields = [
      ['name', expected.name],
      ['price_monthly', expected.priceMonthly],
      ['price_yearly', expected.priceYearly],
      ['employee_limit', expected.employeeLimit],
      ['max_active_jobs', expected.activeJobsLimit],
      ['max_inventory_items', expected.inventoryItemsLimit],
      ['max_storage_bytes', expected.storageBytesLimit],
      ['messages_history_days', 30],
      ['max_material_requests', null],
    ];
    for (const [field, value] of fields) {
      const actual = row[field] == null ? null : Number.isNaN(Number(row[field])) ? row[field] : Number(row[field]);
      if (actual !== value) fail(`Provisioning verification failed: plan ${idText} ${field} does not match the source catalog.`);
    }
    // Migration 037 predates the support-policy migration. Its historical
    // priority_support=false value remains valid until 038 is applied; every
    // other flag must match exactly in either schema state.
    const comparableFeatures = { ...(row.features || {}) };
    const expectedComparableFeatures = { ...expected.features };
    delete comparableFeatures.priority_support;
    delete expectedComparableFeatures.priority_support;
    if (!isDeepStrictEqual(comparableFeatures, expectedComparableFeatures)) {
      fail(`Provisioning verification failed: plan ${idText} feature flags do not match the source catalog.`);
    }
    if (row.support_policy != null && (!isDeepStrictEqual(row.support_policy, expected.supportPolicy) ||
        row.features?.priority_support !== expected.features.priority_support)) {
      fail(`Provisioning verification failed: plan ${idText} support policy does not match the source catalog.`);
    }
  }
  return true;
}

function assertSupportPolicyRows(rows) {
  if (rows.length !== 3) fail('Support policy verification failed: expected plans 1–3.');
  for (const [idText, expected] of Object.entries(SUBSCRIPTION_PLANS)) {
    const row = rows.find(item => Number(item.id) === Number(idText));
    if (!row || !isDeepStrictEqual(row.support_policy, expected.supportPolicy) ||
        row.features?.priority_support !== expected.features.priority_support) {
      fail(`Support policy verification failed: plan ${idText} does not match the source catalog.`);
    }
  }
  return true;
}

async function assertSubscriptionSchema(client) {
  const result = await client.query(`
    SELECT
      to_regclass('public.company_storage_usage') IS NOT NULL AS storage_table,
      to_regclass('public.subscription_payments') IS NOT NULL AS payments_table,
      to_regclass('public.subscription_payment_attempts') IS NOT NULL AS attempts_table,
      (SELECT COUNT(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND table_name='plans'
          AND column_name=ANY(ARRAY['price_monthly','price_yearly','max_active_jobs','max_storage_bytes'])) AS plan_columns,
      (SELECT COUNT(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND table_name='inventory_items'
          AND column_name=ANY(ARRAY['image_size_bytes','image_storage_key'])) AS inventory_columns,
      (SELECT COUNT(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND table_name='employee_documents'
          AND column_name=ANY(ARRAY['file_size_bytes','storage_key'])) AS document_columns,
      (SELECT COUNT(*)::int FROM pg_class
        WHERE oid=ANY(ARRAY['public.company_storage_usage'::regclass,
                           'public.subscription_payments'::regclass,
                           'public.subscription_payment_attempts'::regclass])
          AND relrowsecurity AND relforcerowsecurity) AS rls_tables,
      (SELECT COUNT(*)::int FROM pg_policies WHERE schemaname='public'
        AND tablename=ANY(ARRAY['company_storage_usage','subscription_payments','subscription_payment_attempts'])) AS policy_count,
      EXISTS(SELECT 1 FROM pg_roles WHERE rolname='smarterp_app' AND NOT rolsuper AND NOT rolbypassrls) AS app_role_safe,
      CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
        THEN has_schema_privilege('smarterp_app','public','USAGE') ELSE FALSE END AS app_schema_usage,
      CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
        THEN has_table_privilege('smarterp_app','public.company_storage_usage','SELECT')
          AND has_table_privilege('smarterp_app','public.company_storage_usage','INSERT')
          AND has_table_privilege('smarterp_app','public.company_storage_usage','UPDATE')
          AND has_table_privilege('smarterp_app','public.company_storage_usage','DELETE') ELSE FALSE END AS storage_grants,
      CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
        THEN has_table_privilege('smarterp_app','public.subscription_payments','SELECT')
          AND has_table_privilege('smarterp_app','public.subscription_payments','INSERT')
          AND has_table_privilege('smarterp_app','public.subscription_payments','UPDATE') ELSE FALSE END AS payment_grants,
      CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
        THEN has_table_privilege('smarterp_app','public.subscription_payment_attempts','SELECT')
          AND has_table_privilege('smarterp_app','public.subscription_payment_attempts','INSERT')
          AND has_table_privilege('smarterp_app','public.subscription_payment_attempts','UPDATE') ELSE FALSE END AS attempt_grants,
      (SELECT COUNT(*)::int FROM pg_constraint c
        JOIN pg_attribute child ON child.attrelid=c.conrelid AND child.attname='company_id'
        JOIN pg_attribute parent ON parent.attrelid=c.confrelid AND parent.attnum=c.confkey[1]
       WHERE c.contype='f' AND c.conrelid IN ('public.subscription_payments'::regclass,
                                               'public.subscription_payment_attempts'::regclass)
         AND c.confrelid='public.companies'::regclass AND child.atttypid=parent.atttypid
         AND c.conkey[1]=child.attnum AND cardinality(c.conkey)=1 AND cardinality(c.confkey)=1) AS company_fk_count
  `);
  const row = result.rows[0] || {};
  const checks = [
    ['storage_table', true], ['payments_table', true], ['attempts_table', true],
    ['plan_columns', 4], ['inventory_columns', 2], ['document_columns', 2],
    ['rls_tables', 3], ['policy_count', 3], ['app_role_safe', true],
    ['app_schema_usage', true], ['storage_grants', true], ['payment_grants', true],
    ['attempt_grants', true], ['company_fk_count', 2],
  ];
  for (const [key, expected] of checks) {
    if (row[key] !== expected) fail(`Provisioning schema verification failed: ${key} is missing or incorrect.`);
  }
  await assertStorageBackfills(client);
  return row;
}

function assertNoStorageBackfillGaps(metrics) {
  for (const [source, missing] of Object.entries(metrics)) {
    if (Number(missing) > 0) {
      fail(`Provisioning storage backfill verification failed: ${source} has ${missing} unaccounted file record(s).`);
    }
  }
  return true;
}

async function assertStorageBackfills(client) {
  const core = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM inventory_items i
        WHERE i.company_id IS NOT NULL AND i.image_url IS NOT NULL
          AND (COALESCE(i.image_size_bytes,0) <= 0 OR i.image_storage_key IS NULL
            OR NOT EXISTS (SELECT 1 FROM company_storage_usage u
              WHERE u.company_id=i.company_id::text AND u.storage_key=i.image_storage_key
                AND u.file_size_bytes=i.image_size_bytes AND u.source_type='inventory_image'))) AS inventory_images_missing,
      (SELECT COUNT(*)::int FROM employee_documents d
        WHERE d.company_id IS NOT NULL AND d.file_url IS NOT NULL
          AND (COALESCE(d.file_size_bytes,0) <= 0 OR d.storage_key IS NULL
            OR NOT EXISTS (SELECT 1 FROM company_storage_usage u
              WHERE u.company_id=d.company_id::text AND u.storage_key=d.storage_key
                AND u.file_size_bytes=d.file_size_bytes AND u.source_type='employee_document'))) AS employee_documents_missing
  `);
  const gaps = { ...core.rows[0] };
  const optionalSources = [
    {
      relation: 'material_purchase_bills', key: "'purchase-bill:' || source.id::text",
      size: 'source.file_size', type: 'material_purchase_bill', predicate: 'source.file_size > 0',
    },
    {
      relation: 'message_attachments', key: "'message-attachment:' || source.id::text",
      size: 'source.file_size', type: 'message_attachment', predicate: 'source.file_size > 0',
    },
    {
      relation: 'job_messages', key: "'customer-chat:' || source.id::text",
      size: 'source.file_size', type: 'customer_chat_attachment', predicate: 'source.file_size > 0',
    },
    {
      relation: 'job_proof_of_work', key: "'job-proof:' || source.id::text",
      size: `GREATEST(1, ((length(source.photo_url) - strpos(source.photo_url, ',') - 1) * 3 / 4) -
        CASE WHEN right(source.photo_url, 2) = '==' THEN 2 WHEN right(source.photo_url, 1) = '=' THEN 1 ELSE 0 END)`,
      type: 'job_proof_image', predicate: "source.photo_url LIKE 'data:image/%;base64,%'",
    },
  ];
  for (const source of optionalSources) {
    const exists = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${source.relation}`]);
    if (!exists.rows[0]?.exists) continue;
    const result = await client.query(`
      SELECT COUNT(*)::int AS missing
        FROM ${source.relation} source
       WHERE source.company_id IS NOT NULL AND ${source.predicate}
         AND NOT EXISTS (
           SELECT 1 FROM company_storage_usage usage
            WHERE usage.company_id=source.company_id::text
              AND usage.storage_key=${source.key}
              AND usage.source_type='${source.type}'
              AND usage.file_size_bytes=${source.size}
         )
    `);
    gaps[`${source.relation}_missing`] = result.rows[0]?.missing ?? 0;
  }
  assertNoStorageBackfillGaps(gaps);
  return gaps;
}

module.exports = {
  LEGACY_PLAN_NAMES,
  databaseTargetParts,
  assertTargetConfiguration,
  assertIsolatedTarget,
  assertLegacyPlanMapping,
  assertCanonicalPlans,
  assertSupportPolicyRows,
  assertSubscriptionSchema,
  assertNoStorageBackfillGaps,
  assertStorageBackfills,
};
