'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BasePlugin = require('../ai/plugins/base.plugin');
const { stableHash } = require('../services/aiActionApproval');

test('client confirmed flag cannot execute a destructive plugin tool', async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-jwt-secret-for-ai-approval-workflow';
  try {
    let writes = 0;
    class TestPlugin extends BasePlugin {
      constructor() {
        super('Test', 'test');
        this.tools.write_record = {
          name: 'write_record',
          description: 'Write a record',
          parameters: { type: 'object' },
          isDestructive: true,
          execute: async () => { writes += 1; return { success: true }; },
        };
      }
    }
    const plugin = new TestPlugin();
    const user = { id: 'user-1', companyId: 'company-1', role: 'owner' };
    const payload = { title: 'Approved by client flag', confirmed: true };
    const proposal = await plugin.execute('write_record', payload, { user });
    assert.equal(writes, 0);
    assert.equal(proposal.type, 'ACTION_CONFIRMATION_REQUIRED');
    assert.ok(proposal.approval_token);
    assert.deepEqual(proposal.params, { title: 'Approved by client flag' });

    const result = await plugin.execute('write_record', payload, {
      user,
      approvedAiAction: { toolName: 'write_record', payloadHash: stableHash({ title: 'Approved by client flag' }) },
    });
    assert.deepEqual(result, { success: true });
    assert.equal(writes, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
