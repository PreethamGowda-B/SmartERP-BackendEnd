'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const { verifyWebhook, handleWebhookEvent, verifyMetaWebhookSignature } = require('../controllers/whatsappController');
const whatsappWebhookService = require('../services/whatsappWebhookService');

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('WhatsApp verification accepts the configured token without logging credential values', () => {
  const previousToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const originalLog = console.log;
  const entries = [];
  process.env.WHATSAPP_VERIFY_TOKEN = 'configured-test-secret';
  console.log = (...args) => entries.push(args);

  try {
    const res = responseRecorder();
    verifyWebhook({ query: {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'configured-test-secret',
      'hub.challenge': 'private-challenge-value',
    } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'private-challenge-value');
    assert.equal(JSON.stringify(entries).includes('configured-test-secret'), false);
    assert.equal(JSON.stringify(entries).includes('private-challenge-value'), false);
  } finally {
    console.log = originalLog;
    if (previousToken === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
    else process.env.WHATSAPP_VERIFY_TOKEN = previousToken;
  }
});

test('WhatsApp verification fails closed when its verification secret is absent', () => {
  const previousToken = process.env.WHATSAPP_VERIFY_TOKEN;
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  try {
    const res = responseRecorder();
    verifyWebhook({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'any', 'hub.challenge': 'challenge' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.stringify(res.body).includes('challenge'), false);
  } finally {
    if (previousToken === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
    else process.env.WHATSAPP_VERIFY_TOKEN = previousToken;
  }
});

test('Meta signature validation accepts only a valid HMAC-SHA256 over the exact raw body', () => {
  const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'meta-app-secret-for-unit-tests-only';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  assert.equal(verifyMetaWebhookSignature({ rawBody, signature, appSecret: secret }), true);
  assert.equal(verifyMetaWebhookSignature({ rawBody, signature: 'sha256=' + '0'.repeat(64), appSecret: secret }), false);
  assert.equal(verifyMetaWebhookSignature({ rawBody, signature: undefined, appSecret: secret }), false);
  assert.equal(verifyMetaWebhookSignature({ rawBody: Buffer.from('changed'), signature, appSecret: secret }), false);
});

test('WhatsApp event handler rejects missing signature, malformed raw input, and missing app secret before processing', async () => {
  const previousSecret = process.env.WHATSAPP_APP_SECRET;
  const originalProcess = whatsappWebhookService.processWebhookEvent;
  let calls = 0;
  whatsappWebhookService.processWebhookEvent = async () => { calls += 1; };
  const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'meta-app-secret-for-unit-tests-only';
  const validSignature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  try {
    process.env.WHATSAPP_APP_SECRET = secret;
    let res = responseRecorder();
    await handleWebhookEvent({ rawBody, body: {}, headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(calls, 0);

    res = responseRecorder();
    await handleWebhookEvent({ rawBody: undefined, body: {}, headers: { 'x-hub-signature-256': validSignature } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls, 0);

    delete process.env.WHATSAPP_APP_SECRET;
    res = responseRecorder();
    await handleWebhookEvent({ rawBody, body: {}, headers: { 'x-hub-signature-256': validSignature } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(calls, 0);
  } finally {
    whatsappWebhookService.processWebhookEvent = originalProcess;
    if (previousSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = previousSecret;
  }
});

test('WhatsApp event handler accepts a valid signature and acknowledges before asynchronous processing', async () => {
  const previousSecret = process.env.WHATSAPP_APP_SECRET;
  const originalProcess = whatsappWebhookService.processWebhookEvent;
  const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'meta-app-secret-for-unit-tests-only';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  let receivedBody = null;
  whatsappWebhookService.processWebhookEvent = async (body) => { receivedBody = body; };
  try {
    process.env.WHATSAPP_APP_SECRET = secret;
    const res = responseRecorder();
    const body = { object: 'whatsapp_business_account' };
    await handleWebhookEvent({ rawBody, body, headers: { 'x-hub-signature-256': signature } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'EVENT_RECEIVED');
    assert.equal(receivedBody, body);
  } finally {
    whatsappWebhookService.processWebhookEvent = originalProcess;
    if (previousSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = previousSecret;
  }
});

test('password reset routes do not retain predictable HMAC fallback secrets', () => {
  const staffSource = readFileSync(require.resolve('../routes/auth'), 'utf8');
  const customerSource = readFileSync(require.resolve('../routes/customer/auth'), 'utf8');
  for (const source of [staffSource, customerSource]) {
    assert.equal(source.includes('smarterp_default_sec_salt'), false);
    assert.match(source, /SECURITY_CONFIGURATION_ERROR/);
  }
});
