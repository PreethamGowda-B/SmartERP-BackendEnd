'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const AIDataService = require('../services/aiDataService');
const InventoryService = require('../services/inventoryService');
const { getAiErrorResponse } = require('../utils/aiErrorResponse');

const sampleItems = [
  { id: 1, company_id: 'company-a', quantity: 2, min_quantity: 5, is_deleted: false },
  { id: 2, company_id: 'company-a', quantity: 8, min_quantity: 5, is_deleted: false },
  { id: 3, company_id: 'company-b', quantity: 0, min_quantity: 4, is_deleted: false },
  { id: 4, company_id: 'company-a', quantity: 0, min_quantity: 8, is_deleted: true },
  { id: 5, company_id: 'company-a', quantity: 0, min_quantity: 0, is_deleted: false },
];

function lowStockForCompany(companyId) {
  return sampleItems.filter((item) => item.company_id === companyId
    && item.is_deleted !== true
    && Number(item.min_quantity) > 0
    && Number(item.quantity) < Number(item.min_quantity));
}

function withPoolQuery(queryImpl, run) {
  const originalQuery = pool.query;
  pool.query = queryImpl;
  return Promise.resolve().then(run).finally(() => { pool.query = originalQuery; });
}

function assertCanonicalLowStockQuery(sql, params, companyId) {
  assert.match(sql, /FROM inventory_items/i);
  assert.match(sql, /company_id::text\s*=\s*\$1/i);
  assert.match(sql, /quantity\s*<\s*min_quantity/i);
  assert.match(sql, /min_quantity\s*>\s*0/i);
  assert.match(sql, /is_deleted\s*=\s*FALSE/i);
  assert.deepEqual(params, [companyId]);
  assert.doesNotMatch(sql, /\bFROM\s+inventory\b|\bmin_stock_level\b/i);
}

test('AI low-stock count reports only matching, active items from the requested company', async () => {
  await withPoolQuery(async (sql, params) => {
    assertCanonicalLowStockQuery(String(sql), params, params[0]);
    return { rows: [{ low_stock_count: lowStockForCompany(params[0]).length }] };
  }, async () => {
    assert.equal(await AIDataService.getCompanyLowStockCount({ companyId: 'company-a' }), 1);
  });
});

test('AI low-stock count returns zero when inventory exists but none meets its threshold', async () => {
  await withPoolQuery(async (sql, params) => {
    assertCanonicalLowStockQuery(String(sql), params, 'company-a');
    return { rows: [{ low_stock_count: 0 }] };
  }, async () => {
    assert.equal(await AIDataService.getCompanyLowStockCount({ companyId: 'company-a' }), 0);
  });
});

test('AI low-stock count treats an empty company inventory as a valid zero result', async () => {
  await withPoolQuery(async (sql, params) => {
    assertCanonicalLowStockQuery(String(sql), params, 'empty-company');
    return { rows: [{ low_stock_count: 0 }] };
  }, async () => {
    assert.equal(await AIDataService.getCompanyLowStockCount({ companyId: 'empty-company' }), 0);
  });
});

test('AI low-stock count propagates database errors and maps them to a safe unavailable response', async () => {
  const databaseError = Object.assign(new Error('relation inventory does not exist'), { code: '42P01' });
  await withPoolQuery(async () => { throw databaseError; }, async () => {
    await assert.rejects(AIDataService.getCompanyLowStockCount({ companyId: 'company-a' }), (error) => error === databaseError);
  });
  const response = getAiErrorResponse(databaseError);
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'AI_DATA_UNAVAILABLE');
  assert.doesNotMatch(response.body.error, /inventory|42P01|relation/i);
});

test('AI low-stock query is company-scoped and excludes another company data', async () => {
  await withPoolQuery(async (sql, params) => {
    assertCanonicalLowStockQuery(String(sql), params, params[0]);
    return { rows: [{ low_stock_count: lowStockForCompany(params[0]).length }] };
  }, async () => {
    assert.equal(await AIDataService.getCompanyLowStockCount({ companyId: 'company-a' }), 1);
    assert.equal(await AIDataService.getCompanyLowStockCount({ companyId: 'company-b' }), 1);
  });
});

test('inventory specialist tool uses the same existing table, threshold and tenant scoping', async () => {
  await withPoolQuery(async (sql, params) => {
    assertCanonicalLowStockQuery(String(sql), params, 'company-a');
    return { rows: lowStockForCompany(params[0]).map(({ id, quantity, min_quantity }) => ({ id, quantity, min_quantity })) };
  }, async () => {
    const result = await InventoryService.getLowStockItems({ companyId: 'company-a' });
    assert.deepEqual(result, {
      lowStockCount: 1,
      items: [{ id: 1, quantity: 2, min_quantity: 5 }],
    });
  });
});
