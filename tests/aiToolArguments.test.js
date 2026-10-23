'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateToolArguments, MAX_ARGUMENT_BYTES } = require('../ai/plugins/toolArguments');
const pluginRegistry = require('../ai/plugins');
const ProviderFactory = require('../ai/providers/provider.factory');
const ReActEngine = require('../ai/planner/ReAct.engine');

test('tool arguments enforce declared required fields and types before plugin execution', async () => {
  const context = {
    user: { id: '8a691827-c51b-41fa-8c5a-b31df9903827', companyId: 'company-a', role: 'owner' },
    planTier: 'enterprise',
    aiModelScope: 'general',
  };
  await assert.rejects(pluginRegistry.execute('create_job', { title: 42 }, context), { code: 'AI_TOOL_ARGUMENTS_INVALID' });
  await assert.rejects(pluginRegistry.execute('create_job', {}, context), { code: 'AI_TOOL_ARGUMENTS_INVALID' });
});

test('tool arguments reject oversized and prototype-sensitive payloads', () => {
  assert.throws(() => validateToolArguments({ text: 'x'.repeat(MAX_ARGUMENT_BYTES) }), { code: 'AI_TOOL_ARGUMENTS_INVALID' });
  const unsafe = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validateToolArguments(unsafe), { code: 'AI_TOOL_ARGUMENTS_INVALID' });
});

test('ReAct rejects excessive provider tool calls before executing any tool', async () => {
  const originalProvider = ProviderFactory.getProvider;
  let executed = false;
  const registryExecute = pluginRegistry.execute;
  ProviderFactory.getProvider = () => ({
    name: 'mock',
    async generateCompletion() {
      return { content: '', toolCalls: Array.from({ length: 9 }, (_, index) => ({
        id: `call-${index}`,
        function: { name: 'get_jobs', arguments: '{}' },
      })) };
    },
  });
  pluginRegistry.execute = async () => { executed = true; return {}; };
  try {
    await assert.rejects(
      ReActEngine.run({ userPrompt: 'show jobs', context: {}, systemPromptOverride: 'test' }),
      { code: 'AI_TOOL_CALL_LIMIT_EXCEEDED' }
    );
    assert.equal(executed, false);
  } finally {
    ProviderFactory.getProvider = originalProvider;
    pluginRegistry.execute = registryExecute;
  }
});
