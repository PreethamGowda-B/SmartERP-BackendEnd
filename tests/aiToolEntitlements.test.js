'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pluginRegistry = require('../ai/plugins');
const { getRequiredAiToolScopes, hasAiToolEntitlement } = require('../services/aiToolEntitlements');

test('specialist plugin tools require both the plan entitlement and matching selected model scope', () => {
  assert.equal(hasAiToolEntitlement('professional', 'InventoryPlugin', 'get_low_stock_items', 'general'), false);
  assert.equal(hasAiToolEntitlement('professional', 'InventoryPlugin', 'get_low_stock_items', 'inventory'), true);
  assert.equal(hasAiToolEntitlement('starter', 'AttendancePlugin', 'get_today_attendance', 'attendance'), false);
  assert.equal(hasAiToolEntitlement('enterprise', 'GSTReconciliationPlugin', 'get_gst_reconciliation_summary', 'finance'), false);
  assert.equal(hasAiToolEntitlement('enterprise', 'GSTReconciliationPlugin', 'get_gst_reconciliation_summary', 'gst'), true);
  assert.equal(getRequiredAiToolScopes('InventoryPlugin', 'unregistered_inventory_tool'), null);
  assert.equal(hasAiToolEntitlement('enterprise', 'InventoryPlugin', 'unregistered_inventory_tool', 'inventory'), false);
});

test('general jobs remain available under Starter while specialist tools are withheld', () => {
  const tools = pluginRegistry.getAvailableTools({
    user: { role: 'owner', companyId: 'company-a' },
    planTier: 'starter',
    aiModelScope: 'general',
  }).map((item) => item.function.name);
  assert.ok(tools.includes('get_jobs'));
  assert.ok(!tools.includes('get_low_stock_items'));
  assert.ok(!tools.includes('get_today_attendance'));
});

test('missing plan context and general scope cannot directly execute a specialist data tool', async () => {
  const inventory = pluginRegistry.plugins.find((plugin) => plugin.constructor.name === 'InventoryPlugin');
  const originalExecute = inventory.execute;
  let calls = 0;
  inventory.execute = async () => { calls += 1; return []; };
  try {
    await assert.rejects(
      pluginRegistry.execute('get_low_stock_items', {}, {
        user: { id: 'owner-a', role: 'owner', companyId: 'company-a' },
        planTier: 'enterprise',
        aiModelScope: 'general',
      }),
      { code: 'AI_TOOL_ENTITLEMENT_DENIED' },
    );
    await assert.rejects(
      pluginRegistry.execute('get_low_stock_items', {}, {
        user: { id: 'owner-a', role: 'owner', companyId: 'company-a' },
        aiModelScope: 'inventory',
      }),
      { code: 'AI_TOOL_ENTITLEMENT_DENIED' },
    );
    await assert.rejects(
      pluginRegistry.execute('get_low_stock_items', {}, {
        user: { role: 'owner', companyId: 'company-a' },
        planTier: 'enterprise',
        aiModelScope: 'inventory',
      }),
      { code: 'AI_AUTH_CONTEXT_UNAVAILABLE' },
    );
    assert.equal(calls, 0);
  } finally {
    inventory.execute = originalExecute;
  }
});

test('company-wide payroll, finance, and GST tool roles follow existing API authorization', () => {
  const enterprise = (role, aiModelScope) => pluginRegistry.getAvailableTools({
    user: { id: `${role}-a`, role, companyId: 'company-a' }, planTier: 'enterprise', aiModelScope,
  }).map((item) => item.function.name);

  assert.ok(enterprise('admin', 'payroll').includes('get_payroll_summary'));
  assert.ok(!enterprise('hr', 'payroll').includes('get_payroll_summary'));
  assert.ok(enterprise('admin', 'finance').includes('get_revenue_analytics'));
  assert.ok(!enterprise('hr', 'finance').includes('get_unpaid_invoices'));
  assert.ok(enterprise('admin', 'gst').includes('get_gst_reconciliation_summary'));
  assert.ok(!enterprise('hr', 'gst').includes('get_gst_reconciliation_summary'));
});
