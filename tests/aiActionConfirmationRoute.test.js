'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const previousSecret = process.env.JWT_SECRET;
const testSecret = 'integration-test-secret-for-ai-approval-route';
process.env.JWT_SECRET = testSecret;

const redisPath = require.resolve('../utils/redis');
const previousRedisModule = require.cache[redisPath];
const consumedApprovals = new Set();
let redisAvailable = true;
const fakeRedis = {
  async set(key, _value, nx, ex, ttl) {
    if (!redisAvailable) throw new Error('Redis unavailable in deterministic test');
    assert.equal(nx, 'NX');
    assert.equal(ex, 'EX');
    assert.equal(ttl, 300);
    if (consumedApprovals.has(key)) return null;
    consumedApprovals.add(key);
    return 'OK';
  },
};
require.cache[redisPath] = {
  id: redisPath,
  filename: redisPath,
  loaded: true,
  exports: { redisClient: fakeRedis },
};

const router = require('../routes/ai.routes');
if (previousRedisModule) require.cache[redisPath] = previousRedisModule;
else delete require.cache[redisPath];

const ContextEngine = require('../ai/context/context.engine');
const pluginRegistry = require('../ai/plugins');
const MetricsService = require('../ai/telemetry/metrics.service');
const { pool } = require('../db');
const { createApprovalToken, stableHash } = require('../services/aiActionApproval');
const confirmationLayer = router.stack.find((layer) => layer.route?.path === '/confirm-action');
assert.ok(confirmationLayer, 'confirmation route must be registered');
const confirmationHandlers = confirmationLayer.route.stack.map((layer) => layer.handle);
const jobPlugin = pluginRegistry.plugins.find((plugin) => plugin.constructor.name === 'JobsPlugin');
assert.ok(jobPlugin?.tools?.create_job, 'create_job must be a registered destructive tool');

const original = {
  buildContext: ContextEngine.buildContext,
  createJob: jobPlugin.tools.create_job.execute,
  audit: MetricsService.writeAIAuditEvent,
  connect: pool.connect,
  handlers: confirmationHandlers,
};
let writes = 0;
let auditWrites = 0;
let auditFailure = false;
let actionFailure = false;
let connectFailure = false;
let commitFailure = false;
const transactionCommands = [];
let currentTransactionClient;
let releasedClients = 0;
let destroyedClients = 0;

confirmationLayer.route.stack[0].handle = (req, _res, next) => {
  const userId = req.get('x-test-user') || 'owner-1';
  const companyId = req.get('x-test-company') || 'company-1';
  req.user = { id: userId, userId, companyId, company_id: companyId, role: 'owner', name: 'Test Owner' };
  next();
};
confirmationLayer.route.stack[1].handle = (req, _res, next) => {
  req.plan = { id: 3, name: 'Enterprise', features: { ai_assistant: true } };
  next();
};
confirmationLayer.route.stack[2].handle = (_req, _res, next) => next();
confirmationLayer.route.stack[3].handle = (_req, _res, next) => next();
ContextEngine.buildContext = (req) => ({ user: req.user, planTier: 'enterprise', aiModelScope: 'general' });
jobPlugin.tools.create_job.execute = async (params, context) => {
  writes += 1;
  assert.equal(context.user.companyId, 'company-1');
  assert.equal(context.dbClient, currentTransactionClient, 'ERP write receives the client that began the transaction');
  assert.deepEqual(params, { title: 'Test breakdown job' });
  if (actionFailure) throw new Error('simulated ERP write failure');
  return { success: true, job_id: `job-${writes}` };
};
pool.connect = async () => {
  if (connectFailure) throw new Error('simulated connection failure');
  currentTransactionClient = {
    async query(sql) {
    transactionCommands.push(String(sql));
      if (commitFailure && sql === 'COMMIT') throw new Error('simulated ambiguous commit');
      if (commitFailure && sql === 'ROLLBACK') throw new Error('simulated rollback connection loss');
    return { rows: [] };
  },
    release(error) {
      releasedClients += 1;
      if (error) destroyedClients += 1;
    },
  };
  return currentTransactionClient;
};
MetricsService.writeAIAuditEvent = async (event) => {
  auditWrites += 1;
  assert.equal(event.toolName, 'create_job');
  assert.equal(event.status, 'SUCCESS');
  assert.ok(event.queryable, 'audit uses the same transaction client as the ERP write');
  assert.equal(event.queryable, currentTransactionClient);
  if (auditFailure) throw new Error('simulated audit insert failure');
};

function signExpiredApproval(scope) {
  return jwt.sign({
    sub: scope.userId,
    companyId: scope.companyId,
    action: scope.action,
    payloadHash: stableHash(scope.payload),
    jti: `expired-${Date.now()}`,
  }, testSecret, { algorithm: 'HS256', expiresIn: -1, issuer: 'smarterp-ai', audience: 'smarterp-ai-action' });
}

async function postConfirmation(_port, { approvalToken, params = { title: 'Test breakdown job' }, userId = 'owner-1', companyId = 'company-1', toolName = 'create_job' }) {
  const req = {
    body: { toolName, params, approval_token: approvalToken },
    user: { id: userId, userId, companyId, company_id: companyId, role: 'owner', name: 'Test Owner' },
    headers: {}, ip: '127.0.0.1', get: () => 'test-agent',
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await confirmationHandlers[4](req, res);
  return { status: res.statusCode, body: res.body };
}

test('confirmation route enforces scope, expiry, Redis availability, single use and audits one write', async (t) => {
  t.after(() => {
    confirmationLayer.route.stack.forEach((layer, index) => { layer.handle = original.handlers[index]; });
    ContextEngine.buildContext = original.buildContext;
    jobPlugin.tools.create_job.execute = original.createJob;
    MetricsService.writeAIAuditEvent = original.audit;
    pool.connect = original.connect;
    redisAvailable = true;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const port = 0;

  const scope = {
    userId: 'owner-1', companyId: 'company-1', action: 'plugin_tool:create_job',
    payload: { title: 'Test breakdown job' },
  };
  const wrongCompanyToken = createApprovalToken(scope, testSecret);
  const wrongCompany = await postConfirmation(port, { approvalToken: wrongCompanyToken, companyId: 'company-2' });
  assert.equal(wrongCompany.status, 403);
  const wrongUserToken = createApprovalToken(scope, testSecret);
  const wrongUser = await postConfirmation(port, { approvalToken: wrongUserToken, userId: 'owner-2' });
  assert.equal(wrongUser.status, 403);
  const wrongActionToken = createApprovalToken({ ...scope, action: 'plugin_tool:delete_job' }, testSecret);
  const wrongAction = await postConfirmation(port, { approvalToken: wrongActionToken });
  assert.equal(wrongAction.status, 403);
  const modifiedPayloadToken = createApprovalToken(scope, testSecret);
  const modifiedPayload = await postConfirmation(port, { approvalToken: modifiedPayloadToken, params: { title: 'Different job' } });
  assert.equal(modifiedPayload.status, 403);
  const expired = await postConfirmation(port, { approvalToken: signExpiredApproval(scope) });
  assert.equal(expired.status, 403);
  assert.equal(writes, 0);

  const redisFailureToken = createApprovalToken(scope, testSecret);
  redisAvailable = false;
  const redisFailure = await postConfirmation(port, { approvalToken: redisFailureToken });
  assert.equal(redisFailure.status, 503);
  assert.equal(redisFailure.body.code, 'AI_APPROVAL_STORE_UNAVAILABLE');
  assert.equal(writes, 0);
  redisAvailable = true;

  const token = createApprovalToken(scope, testSecret);
  const concurrent = await Promise.all([
    postConfirmation(port, { approvalToken: token }),
    postConfirmation(port, { approvalToken: token }),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
  assert.equal(writes, 1);
  assert.equal(auditWrites, 1);
  assert.equal(transactionCommands.filter((sql) => sql === 'BEGIN').length, 1);
  assert.equal(transactionCommands.filter((sql) => sql === 'COMMIT').length, 1);
  assert.equal(releasedClients, 1);
  const replay = await postConfirmation(port, { approvalToken: token });
  assert.equal(replay.status, 409);
  assert.equal(writes, 1);
  assert.equal(auditWrites, 1);

  auditFailure = true;
  const auditFailureToken = createApprovalToken(scope, testSecret);
  const failedAudit = await postConfirmation(port, { approvalToken: auditFailureToken });
  assert.equal(failedAudit.status, 503);
  assert.equal(failedAudit.body.code, 'AI_ACTION_NOT_COMMITTED');
  assert.match(failedAudit.body.error, /No changes were committed.*new approval/);
  assert.equal(transactionCommands.at(-1), 'ROLLBACK');
  assert.equal((await postConfirmation(port, { approvalToken: auditFailureToken })).status, 409);
  auditFailure = false;

  const auditsBeforeActionFailure = auditWrites;
  actionFailure = true;
  const actionFailureToken = createApprovalToken(scope, testSecret);
  const failedAction = await postConfirmation(port, { approvalToken: actionFailureToken });
  assert.equal(failedAction.status, 503);
  assert.equal(failedAction.body.code, 'AI_ACTION_NOT_COMMITTED');
  assert.equal(transactionCommands.at(-1), 'ROLLBACK');
  assert.equal(auditWrites, auditsBeforeActionFailure);
  assert.equal(releasedClients, 3, 'client is released after success and both failure paths');
  assert.equal((await postConfirmation(port, { approvalToken: actionFailureToken })).status, 409);
  actionFailure = false;

  connectFailure = true;
  const connectionFailureToken = createApprovalToken(scope, testSecret);
  const connectionFailure = await postConfirmation(port, { approvalToken: connectionFailureToken });
  assert.equal(connectionFailure.status, 503);
  assert.equal(connectionFailure.body.code, 'AI_ACTION_NOT_COMMITTED');
  assert.equal((await postConfirmation(port, { approvalToken: connectionFailureToken })).status, 409);
  connectFailure = false;

  commitFailure = true;
  const commitFailureToken = createApprovalToken(scope, testSecret);
  const unknownCommit = await postConfirmation(port, { approvalToken: commitFailureToken });
  assert.equal(unknownCommit.status, 503);
  assert.equal(unknownCommit.body.code, 'AI_ACTION_COMMIT_OUTCOME_UNKNOWN');
  assert.match(unknownCommit.body.error, /Check the record and audit log/);
  assert.equal(transactionCommands.at(-1), 'ROLLBACK');
  assert.equal(destroyedClients, 1, 'client is destroyed when rollback fails rather than returned to the pool');
});
