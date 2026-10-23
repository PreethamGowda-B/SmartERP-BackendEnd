'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getAiErrorResponse } = require('../utils/aiErrorResponse');

test('AI failures have distinct safe provider, data, timeout, and tool responses', () => {
  assert.deepEqual(getAiErrorResponse({ code: 'AI_PROVIDER_UNAVAILABLE' }), {
    status: 503,
    body: { code: 'AI_PROVIDER_UNAVAILABLE', error: 'SmartERP AI provider is temporarily unavailable. Please retry shortly.' },
  });
  assert.equal(getAiErrorResponse({ code: '42703', message: 'secret database detail' }).body.code, 'AI_DATA_UNAVAILABLE');
  assert.equal(getAiErrorResponse({ code: 'ETIMEDOUT' }).status, 504);
  assert.equal(getAiErrorResponse({ code: 'AI_TOOL_EXECUTION_FAILED' }).body.error.includes('No successful result'), true);
  assert.equal(JSON.stringify(getAiErrorResponse({ code: '42703', message: 'secret database detail' })).includes('secret database detail'), false);
});

test('AI summary query errors propagate instead of being represented as verified zero results', async () => {
  const { pool } = require('../db');
  const AIDataService = require('../services/aiDataService');
  const originalQuery = pool.query;
  pool.query = async () => { throw Object.assign(new Error('synthetic query failure'), { code: '08006' }); };
  try {
    await assert.rejects(AIDataService.getCompanyLowStockCount({ companyId: 'synthetic-company' }), /synthetic query failure/);
  } finally {
    pool.query = originalQuery;
  }
});

test('AI workflow sources do not manufacture revenue, default missing machine health to 100%, or claim unperformed notifications', () => {
  const copilot = fs.readFileSync(path.join(__dirname, '..', 'routes', 'businessCopilot.js'), 'utf8');
  assert.doesNotMatch(copilot, /150000|health_score \|\| 100/);
  assert.doesNotMatch(copilot, /notified Operations|telemetry checked cleanly/);
  assert.doesNotMatch(copilot, /\.catch\(\(\) => \(\{ rows: \[\{ total: 150000 \}\] \}\)\)/);
  assert.match(copilot, /AI_WORKFLOW_NOT_IMPLEMENTED/);
  assert.doesNotMatch(copilot, /Prompt: "\$\{prompt\}"/);
  const agentRoutes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.routes.js'), 'utf8');
  assert.match(agentRoutes, /AI request \(\$\{finalResult\.activeModelScope/);
  assert.doesNotMatch(agentRoutes, /promptPreview: cleanMessage/);
});

test('AI tool failures and empty model responses cannot be converted into a fabricated success', () => {
  const engine = fs.readFileSync(path.join(__dirname, '..', 'ai', 'planner', 'ReAct.engine.js'), 'utf8');
  assert.match(engine, /AI_TOOL_EXECUTION_FAILED/);
  assert.match(engine, /AI_AGENT_ITERATION_LIMIT/);
  assert.match(engine, /AI_EMPTY_RESPONSE/);
  assert.doesNotMatch(engine, /processed your request using live system data/);
});

test('AI routes guard agent, chat, copilot, and confirmation parameters before any tool execution', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.routes.js'), 'utf8');
  const copilot = fs.readFileSync(path.join(__dirname, '..', 'routes', 'businessCopilot.js'), 'utf8');
  assert.match(routes, /"\/agent"[\s\S]*?validateAiPrompt/);
  assert.match(routes, /"\/chat"[\s\S]*?validateAiPrompt/);
  assert.match(routes, /findBlockedActionInput\(params\)/);
  assert.match(copilot, /validateCopilotPrompt/);
});

test('CNC AI data lookups do not hide query failures or broaden a machine search to all company jobs', () => {
  const cnc = fs.readFileSync(path.join(__dirname, '..', 'ai', 'plugins', 'cnc.plugin.js'), 'utf8');
  assert.doesNotMatch(cnc, /\.catch\(\(\) => \(\{ rows: \[\] \}\)\)/);
  assert.doesNotMatch(cnc, /SELECT id, title, description, status, priority, created_at FROM jobs\s+WHERE company_id::text = \$1::text ORDER BY created_at DESC LIMIT \$2/);
  assert.match(cnc, /WHERE m\.company_id::text = \$1::text/);
  assert.match(cnc, /c\.company_id::text = m\.company_id::text/);
  assert.match(cnc, /p\.company_id::text = m\.company_id::text/);
  assert.match(cnc, /m\.company_id::text = w\.company_id::text/);
});
