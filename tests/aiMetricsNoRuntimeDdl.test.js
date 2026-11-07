'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const MetricsService = require('../ai/telemetry/metrics.service');

test('AI telemetry operations use migrated tables without runtime DDL', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, params = []) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).includes('AVG(latency_ms)')) return { rows: [{ avg_latency: '8' }] };
    if (String(sql).includes('COUNT(*)')) return { rows: [{ count: '2' }] };
    if (String(sql).includes('GROUP BY')) return { rows: [] };
    if (String(sql).includes('FROM public.ai_audit_logs')) return { rows: [{ id: 1 }] };
    return { rows: [] };
  };

  try {
    const userContext = { user: { id: 'user-1', companyId: 'company-1', role: 'owner' } };
    await MetricsService.logAIAuditEvent({
      userContext,
      toolName: 'ListInvoices',
      params: { status: 'pending' },
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
    });
    await MetricsService.logAIInterception({ userContext, prompt: 'restricted request', matchedKeyword: 'payroll', planTier: 'starter' });
    const stats = await MetricsService.getAIStats();
    const logs = await MetricsService.getAuditLogs({ page: 1, limit: 10 });

    assert.equal(stats.requestsToday, 2);
    assert.deepEqual(logs.logs, [{ id: 1 }]);
    assert.ok(calls.some(({ params }) => params.includes('openai/gpt-oss-20b')));
    const auditRead = calls.find(({ sql }) => sql.includes('FROM public.ai_audit_logs'))?.sql || '';
    assert.match(auditRead, /SELECT id, company_id, user_id/);
    assert.doesNotMatch(auditRead, /SELECT \*|\b(?:user_name|prompt|details)\b/i, 'audit API projection excludes historical raw content columns');
    assert.ok(calls.every(({ sql }) => !/\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql)), 'telemetry request SQL must not contain DDL');
  } finally {
    pool.query = originalQuery;
  }
});
