'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { Readable } = require('node:stream');
const {
  classifyAddress,
  createMeasuredFetch,
  flushMeasurements,
  instrumentRedisClient,
  observePostgresQuery,
  outboundBandwidthMonitoringEnabled,
  installOutboundBandwidthMonitoring,
  measureDatabaseFileParameter,
  observeHttpRequest,
  recordMeasurement,
  withOutboundOperation,
} = require('../utils/outboundBandwidth');

installOutboundBandwidthMonitoring();

test('HTTP transport records write and end body bytes and response bytes once', async () => {
  class FakeRequest extends EventEmitter {
    write() { return true; }
    end() { return this; }
  }
  const request = new FakeRequest();
  observeHttpRequest(request, { host: '127.0.0.1', method: 'POST' }, process.hrtime.bigint());
  request.write(Buffer.from('ab'));
  request.end(Buffer.from('cde'));

  const response = new Readable({ read() {} });
  response.statusCode = 201;
  response.socket = { remoteAddress: '127.0.0.1' };
  const ended = new Promise((resolve) => response.once('end', resolve));
  response.headers = { 'content-length': '5' };
  request.emit('response', response);
  response.push(Buffer.from('saved'));
  response.push(null);
  response.resume();
  await ended;

  const loggedLines = [];
  const originalInfo = console.info;
  console.info = (line) => loggedLines.push(String(line));
  let entries;
  try { entries = flushMeasurements(); } finally { console.info = originalInfo; }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].destination, '127.0.0.1');
  assert.equal(entries[0].endpoint, '/');
  assert.equal(entries[0].operation, 'POST');
  assert.equal(entries[0].networkClass, 'private_or_reserved');
  assert.equal(entries[0].outboundRequestBodyBytes, 5);
  assert.equal(entries[0].responseBodyBytesReceived, 5);
  assert.equal(entries[0].measurementKind, 'measured_request_estimated_response');
  assert.equal(entries[0].successfulRequests, 1);
  assert.equal(entries[0].failedRequests, 0);
  assert.ok(entries[0].durationMsMax >= 0);
  assert.equal(loggedLines.join('\n').includes('/private/path'), false);
  assert.equal(loggedLines.join('\n').includes('secret=value'), false);
  assert.equal(loggedLines.join('\n').includes('saved'), false);
});

test('HTTP error status is recorded as a failed request with response bytes separate', async () => {
  class FakeRequest extends EventEmitter {
    write() { return true; }
    end() { return this; }
  }
  const request = new FakeRequest();
  observeHttpRequest(request, { host: '8.8.8.8', method: 'GET' }, process.hrtime.bigint());
  const response = new Readable({ read() {} });
  response.statusCode = 503;
  response.headers = { 'content-length': '11' };
  response.socket = { remoteAddress: '8.8.8.8' };
  const ended = new Promise((resolve) => response.once('end', resolve));
  request.emit('response', response);
  response.push(Buffer.from('unavailable'));
  response.push(null);
  response.resume();
  await ended;

  const measurement = flushMeasurements()[0];
  assert.equal(measurement.networkClass, 'public');
  assert.equal(measurement.outboundRequestBodyBytes, 0);
  assert.equal(measurement.responseBodyBytesReceived, Buffer.byteLength('unavailable'));
  assert.equal(measurement.successfulRequests, 0);
  assert.equal(measurement.failedRequests, 1);
});

test('Fetch transport measures JSON request and consumed response bodies', async () => {
  const originalResponse = new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '11' },
  });
  const measuredFetch = createMeasuredFetch(async () => originalResponse);
  const response = await withOutboundOperation('test-fetch', 'json_call', () => measuredFetch(
    'https://api.groq.com/chat/completions?private=value',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' },
  ), { responsibleModule: 'tests/outboundBandwidth', retryCount: 1 });
  assert.equal(response, originalResponse, 'monitor must not replace the caller response');
  assert.deepEqual(await response.json(), { ok: true });

  const entries = flushMeasurements();
  const measurement = entries.find((entry) => entry.service === 'test-fetch');
  assert.ok(measurement);
  assert.equal(measurement.destination, 'api.groq.com');
  assert.equal(measurement.endpoint, '/chat/completions');
  assert.equal(measurement.responsibleModule, 'tests/outboundBandwidth');
  assert.equal(measurement.retryCount, 1);
  assert.equal(measurement.networkClass, 'public');
  assert.equal(measurement.outboundRequestBodyBytes, Buffer.byteLength('{"x":1}'));
  assert.equal(measurement.responseBodyBytesReceived, Buffer.byteLength('{"ok":true}'));
  assert.equal(measurement.operation, 'json_call');
});

test('PostgreSQL binary upload counter records file size without response/body content', async () => {
  const privateFileBytes = Buffer.from('do-not-log-this-private-file');
  await measureDatabaseFileParameter({
    operation: 'attachment_insert',
    fileBytes: privateFileBytes.byteLength,
    run: async () => ({ rows: [{ id: 'fixture-id' }] }),
  });

  const measurement = flushMeasurements().find((entry) => entry.service === 'supabase-postgres');
  assert.ok(measurement);
  assert.equal(measurement.outboundRequestBodyBytes, privateFileBytes.byteLength);
  assert.equal(measurement.responseBodyBytesReceived, null);
  assert.equal(measurement.responsesWithUnknownBody, 1);
  assert.equal(measurement.successfulRequests, 1);
  assert.equal(JSON.stringify(measurement).includes(privateFileBytes.toString()), false);
});

test('Redis IP classification distinguishes public, private, and unavailable addresses', () => {
  assert.equal(classifyAddress('10.0.0.4'), 'private_or_reserved');
  assert.equal(classifyAddress('203.0.113.8'), 'private_or_reserved');
  assert.equal(classifyAddress('8.8.8.8'), 'public');
  assert.equal(classifyAddress('198.51.100.8'), 'private_or_reserved');
  assert.equal(classifyAddress('198.51.2.8'), 'public');
  assert.equal(classifyAddress(undefined), 'unknown');
  assert.equal(classifyAddress('2001:db8::1'), 'unknown');
  assert.equal(classifyAddress('2001:4860:4860::8888'), 'public');
  assert.equal(classifyAddress('ff02::1'), 'unknown');
});

test('HTTP module hook preserves a real local request and response stream', async (t) => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      assert.equal(Buffer.concat(chunks).toString(), 'upload-body');
      res.setHeader('content-length', '12');
      res.write(Buffer.from('first-'));
      res.end(Buffer.from('second'));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const body = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: address.port, method: 'POST', path: '/private?token=not-logged' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    request.on('error', reject);
    request.write(Buffer.from('upload-'));
    request.end(Buffer.from('body'));
  });
  assert.equal(body, 'first-second');

  const measurements = flushMeasurements();
  const entry = measurements.find((measurement) => measurement.operation === 'POST');
  assert.ok(entry);
  assert.equal(entry.outboundRequestBodyBytes, Buffer.byteLength('upload-body'));
  assert.equal(entry.responseBodyBytesReceived, Buffer.byteLength('first-second'));
  assert.equal(entry.networkClass, 'private_or_reserved');
});

test('fetch streaming upload and large streaming response are forwarded without buffering', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.write(Buffer.alloc(1024 * 512, 0x61));
      res.end(Buffer.alloc(1024 * 512, 0x62));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const upload = new Readable({ read() { this.push(Buffer.from('stream-')); this.push(Buffer.from('upload')); this.push(null); } });
  const response = await fetch(`http://127.0.0.1:${address.port}/stream`, {
    method: 'POST',
    body: upload,
    duplex: 'half',
  });
  const bytes = await response.arrayBuffer();
  assert.equal(bytes.byteLength, 1024 * 1024);

  const entries = flushMeasurements();
  const entry = entries.find((measurement) => measurement.destination === '127.0.0.1' && measurement.operation === 'POST');
  assert.ok(entry);
  assert.equal(entry.requestsWithUnknownBody, 1);
  assert.equal(entry.responseBodyBytesReceived, null, 'chunked response remains unknown rather than changing stream flow');
});

test('telemetry sink exceptions do not escape flush and measurements are retained for retry', () => {
  for (let index = 0; index < 40; index += 1) {
    recordMeasurement({
      destination: 'api.groq.com',
      service: 'groq',
      operation: `operation_${index}`,
      requestBodyBytes: index,
      responseBodyBytes: 1,
      durationMs: 1,
      success: true,
    });
  }
  const originalInfo = console.info;
  console.info = () => { throw new Error('sink unavailable'); };
  let entries;
  try { assert.doesNotThrow(() => { entries = flushMeasurements(); }); }
  finally { console.info = originalInfo; }
  assert.equal(entries.length, 0);
  const retained = [];
  console.info = (line) => retained.push(String(line));
  try { entries = flushMeasurements(); } finally { console.info = originalInfo; }
  assert.equal(entries.length, 32);
  assert.equal(entries.at(-1).measurementSource, 'aggregated_overflow');
  assert.equal(retained.length, 32);
});

test('failed fetch is measured without replacing the original network error', async () => {
  const original = new Error('DNS test failure');
  const measuredFetch = createMeasuredFetch(async () => { throw original; });
  await assert.rejects(measuredFetch('https://api.groq.com/unlogged?secret=x'), (error) => error === original);
  const entry = flushMeasurements().find((measurement) => measurement.destination === 'api.groq.com');
  assert.ok(entry);
  assert.equal(entry.failedRequests, 1);
});

test('Redis command measurement is sidecar-only and excludes command data from logs', async () => {
  const client = {
    stream: { remoteAddress: '10.0.0.4' },
    sendCommand(command) { return Promise.resolve(Buffer.from('ok')); },
  };
  instrumentRedisClient(client);
  const result = await client.sendCommand({ name: 'SET', args: ['private:key', 'secret-value'] });
  assert.equal(result.toString(), 'ok');
  await new Promise((resolve) => setImmediate(resolve));
  const measurement = flushMeasurements().find((entry) => entry.service === 'redis');
  assert.ok(measurement);
  assert.equal(measurement.operation, 'set');
  assert.equal(measurement.measurementKind, 'estimated_redis_protocol_bytes');
  assert.equal(JSON.stringify(measurement).includes('secret-value'), false);
});

test('PostgreSQL query estimates omit binary parameter values to avoid file-meter double counting', async () => {
  const result = observePostgresQuery({
    text: 'SELECT id FROM users WHERE email = $1',
    values: ['person@example.test'],
    run: async () => ({ rows: [{ id: '1' }] }),
  });
  await result;
  await new Promise((resolve) => setImmediate(resolve));
  const measurement = flushMeasurements().find((entry) => entry.measurementSource === 'postgres_query_payload_estimate');
  assert.ok(measurement);
  assert.equal(measurement.operation, 'select');
  assert.equal(measurement.measurementKind, 'estimated_postgres_query_bytes_excluding_binary_parameters');
  assert.equal(JSON.stringify(measurement).includes('person@example.test'), false);

  await observePostgresQuery({ text: 'INSERT INTO files(data) VALUES ($1)', values: [Buffer.from('private file')], run: async () => ({ rowCount: 1 }) });
  await new Promise((resolve) => setImmediate(resolve));
  const binaryMeasurement = flushMeasurements().find((entry) => entry.operation === 'insert');
  assert.equal(binaryMeasurement.outboundRequestBodyBytes, null);
});

test('dedicated PostgreSQL file measurement suppresses the overlapping general query record', async () => {
  await measureDatabaseFileParameter({
    operation: 'site_proof_insert',
    fileBytes: Buffer.byteLength('data:image/jpeg;base64,ZmFrZQ=='),
    run: () => observePostgresQuery({
      text: 'INSERT INTO job_proof_of_work(photo_url) VALUES ($1)',
      values: ['data:image/jpeg;base64,ZmFrZQ=='],
      run: async () => ({ rowCount: 1 }),
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const entries = flushMeasurements();
  assert.equal(entries.filter((entry) => entry.measurementSource === 'postgres_file_parameter').length, 1);
  assert.equal(entries.filter((entry) => entry.measurementSource === 'postgres_query_payload_estimate').length, 0);
});

test('Redis duplicate clients retain instrumentation for BullMQ-style connections', () => {
  const client = {
    sendCommand() { return Promise.resolve('ok'); },
    duplicate() { return { sendCommand() { return Promise.resolve('ok'); } }; },
  };
  instrumentRedisClient(client);
  const duplicate = client.duplicate();
  assert.equal(duplicate.sendCommand.__outboundBandwidthWrapped, true);
});

test('outbound telemetry is an explicit staging-only opt-in', () => {
  assert.equal(outboundBandwidthMonitoringEnabled({ NODE_ENV: 'production', OUTBOUND_BANDWIDTH_TELEMETRY: 'true' }), false);
  assert.equal(outboundBandwidthMonitoringEnabled({ NODE_ENV: 'staging', OUTBOUND_BANDWIDTH_TELEMETRY: 'false' }), false);
  assert.equal(outboundBandwidthMonitoringEnabled({ NODE_ENV: 'staging', OUTBOUND_BANDWIDTH_TELEMETRY: 'true' }), true);
});
