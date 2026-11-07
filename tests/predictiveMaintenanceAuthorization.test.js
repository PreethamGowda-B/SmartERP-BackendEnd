'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCompanyScope } = require('../routes/predictiveMaintenance');

test('predictive maintenance requires an authorized role and company-scoped query context', () => {
  assert.deepEqual(resolveCompanyScope({ role: 'owner', companyId: 'co-1' }), { companyId: 'co-1' });
  assert.deepEqual(resolveCompanyScope({ role: 'employee', companyId: 'co-1' }), { error: 'FORBIDDEN' });
  assert.deepEqual(resolveCompanyScope({ role: 'owner', companyId: 'co-1' }, 'co-2'), { error: 'FORBIDDEN' });
  assert.deepEqual(resolveCompanyScope({ role: 'super_admin' }), { error: 'COMPANY_REQUIRED' });
  assert.deepEqual(resolveCompanyScope({ role: 'super_admin' }, 'co-2'), { companyId: 'co-2' });
});
