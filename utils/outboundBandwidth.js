'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const { AsyncLocalStorage } = require('async_hooks');

const FLUSH_INTERVAL_MS = Number(process.env.BANDWIDTH_FLUSH_INTERVAL_MS || (process.env.NODE_ENV === 'production' ? 300_000 : 60_000));
const MAX_BUCKETS = 32;
const OVERFLOW_KEY = 'other|other|other|unknown|aggregated_overflow';
const operationContext = new AsyncLocalStorage();
const databaseMeasurementContext = new AsyncLocalStorage();
const buckets = new Map();
let installed = false;
let flushTimer = null;

const SERVICE_HOSTS = [
  [/cloudinary\.com$/i, 'cloudinary'],
  [/groq\.com$/i, 'groq'],
  [/resend\.com$/i, 'resend'],
  [/razorpay\.com$/i, 'razorpay'],
  [/facebook\.com$/i, 'meta-whatsapp'],
  [/googleapis\.com$/i, 'google-firebase'],
  [/firebaseio\.com$/i, 'firebase'],
  [/sentry\.io$/i, 'sentry'],
];

function hostFrom(value, protocol = 'http:') {
  try {
    if (value instanceof URL) return value.hostname.toLowerCase();
    if (typeof value === 'string' && /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      return new URL(value).hostname.toLowerCase();
    }
    const options = value && typeof value === 'object' ? value : {};
    const host = options.hostname || options.host || options.servername;
    return host ? new URL(`${options.protocol || protocol}//${host}`).hostname.toLowerCase() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function serviceForHost(host) {
  const match = SERVICE_HOSTS.find(([pattern]) => pattern.test(host));
  return match ? match[1] : 'external-http';
}

function safeMonitorLog(message) {
  try { console.warn(`[outbound-bandwidth] ${message}`); } catch { /* telemetry must not affect the application */ }
}

function classifyFetchHost(host) {
  const normalized = String(host || '').toLowerCase();
  if (net.isIP(normalized)) return classifyAddress(normalized);
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal')) {
    return 'private_or_reserved';
  }
  return serviceForHost(normalized) !== 'external-http' ? 'public' : 'unknown';
}

function classifyAddress(address) {
  if (!address) return 'unknown';
  let ip = String(address).toLowerCase().split('%')[0];
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const version = net.isIP(ip);
  if (version === 4) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    const privateOrReserved = a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && octets[2] === 0)
      || (a === 192 && b === 0 && octets[2] === 2)
      || (a === 192 && b === 88 && octets[2] === 99)
      || (a === 192 && b === 2 && octets[2] === 0)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && octets[2] === 100)
      || (a === 203 && b === 0 && octets[2] === 113);
    return privateOrReserved ? 'private_or_reserved' : 'public';
  }
  if (version === 6) {
    if (ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
      return 'private_or_reserved';
    }
    const firstHextet = Number.parseInt(ip.split(':')[0] || '0', 16);
    if (firstHextet >= 0x2000 && firstHextet <= 0x3fff && !ip.startsWith('2001:db8:')) return 'public';
    return 'unknown';
  }
  return 'unknown';
}

function finiteBytes(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function bodyLength(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return Buffer.byteLength(value.toString());
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  return null;
}

function declaredContentLength(headers) {
  try {
    const raw = typeof headers?.get === 'function'
      ? headers.get('content-length')
      : (headers?.['content-length'] ?? headers?.['Content-Length']);
    const value = Array.isArray(raw) ? raw[0] : raw;
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function makeBucket(sample) {
  const now = new Date().toISOString();
  return {
    service: sample.service,
    destination: sample.destination,
    operation: sample.operation,
    measurementSource: sample.measurementSource || 'http_transport_body',
    measurementKind: sample.measurementKind || 'measured_application_payload',
    networkClass: sample.networkClass || 'unknown',
    requestCount: 0,
    redirectedRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    outboundRequestBodyBytes: 0,
    requestsWithMeasuredBody: 0,
    requestsWithUnknownBody: 0,
    responseBodyBytesReceived: 0,
    responsesWithMeasuredBody: 0,
    responsesWithUnknownBody: 0,
    durationMsTotal: 0,
    durationMsMax: 0,
    windowStartedAt: now,
    windowEndedAt: now,
  };
}

function recordMeasurement(sample) {
  try {
    const context = operationContext.getStore() || {};
    const rawDestination = String(sample.destination || 'unknown').toLowerCase();
    const hostService = serviceForHost(rawDestination);
    // Preserve known integration names while avoiding arbitrary/tenant-controlled hostnames in logs.
    const destination = ['database-url', 'redis'].includes(rawDestination) ? rawDestination
      : (hostService === 'external-http' ? 'external-http' : hostService);
    const serviceCandidate = String(sample.service || context.service || hostService);
    const service = /^[a-z0-9_-]{1,64}$/i.test(serviceCandidate) ? serviceCandidate : 'external-http';
    const operationCandidate = String(sample.operation || context.operation || 'unknown');
    const operation = /^[a-z0-9_-]{1,48}$/i.test(operationCandidate) ? operationCandidate : 'other';
    const measurementSource = /^[a-z0-9_-]{1,48}$/i.test(sample.measurementSource || '')
      ? sample.measurementSource
      : 'http_transport_body';
    const measurementKind = /^[a-z0-9_-]{1,64}$/i.test(sample.measurementKind || '')
      ? sample.measurementKind
      : 'measured_application_payload';
    const networkClass = ['public', 'private_or_reserved', 'unknown'].includes(sample.networkClass)
      ? sample.networkClass
      : 'unknown';
    const key = `${service}|${destination}|${operation}|${networkClass}|${measurementSource}|${measurementKind}`;
    let bucket = buckets.get(key);
    if (!bucket && buckets.size >= MAX_BUCKETS - 1) {
      bucket = buckets.get(OVERFLOW_KEY);
      if (!bucket) {
        bucket = makeBucket({ service: 'other', destination: 'other', operation: 'other', networkClass: 'unknown', measurementSource: 'aggregated_overflow', measurementKind: 'mixed_estimate' });
        buckets.set(OVERFLOW_KEY, bucket);
      }
    }
    if (!bucket) {
      bucket = makeBucket({ service, destination, operation, networkClass, measurementSource, measurementKind });
      buckets.set(key, bucket);
    }

    const requestBytes = finiteBytes(sample.requestBodyBytes);
    const responseBytes = finiteBytes(sample.responseBodyBytes);
    const duration = finiteBytes(sample.durationMs) ?? 0;
    bucket.requestCount += 1;
    bucket.redirectedRequests += sample.redirected ? 1 : 0;
    bucket.successfulRequests += sample.success ? 1 : 0;
    bucket.failedRequests += sample.success ? 0 : 1;
    if (requestBytes === null) bucket.requestsWithUnknownBody += 1;
    else {
      bucket.requestsWithMeasuredBody += 1;
      bucket.outboundRequestBodyBytes += requestBytes;
    }
    if (responseBytes === null) bucket.responsesWithUnknownBody += 1;
    else {
      bucket.responsesWithMeasuredBody += 1;
      bucket.responseBodyBytesReceived += responseBytes;
    }
    bucket.durationMsTotal += duration;
    bucket.durationMsMax = Math.max(bucket.durationMsMax, duration);
    bucket.windowEndedAt = new Date().toISOString();
  } catch {
    // Measurement is deliberately best-effort; it must never affect a business request.
  }
}

function serialiseBucket(bucket) {
  return {
    ...bucket,
    outboundRequestBodyBytes: bucket.requestsWithMeasuredBody ? bucket.outboundRequestBodyBytes : null,
    responseBodyBytesReceived: bucket.responsesWithMeasuredBody ? bucket.responseBodyBytesReceived : null,
    durationMsAverage: bucket.requestCount ? Math.round(bucket.durationMsTotal / bucket.requestCount) : 0,
  };
}

function flushMeasurements() {
  const output = [];
  let failedWrites = 0;
  let totalRequests = 0;
  let totalSuccessful = 0;
  let totalFailed = 0;
  let totalMeasuredOutboundBytes = 0;
  let totalEstimatedOutboundBytes = 0;
  let totalMeasuredInboundBytes = 0;
  const serviceSummary = new Map();

  // Delete only after this specific log write succeeds. A process crash or an
  // ambiguous sink failure may therefore produce a duplicate on retry, but it
  // never silently loses a measurement window.
  for (const [key, bucket] of buckets.entries()) {
    const measurement = serialiseBucket(bucket);
    try {
      // Always write the bucket measurement event so telemetry sink and unit test verification pass
      console.info(JSON.stringify({
        level: 'info',
        event: 'outbound_bandwidth_window',
        measurementScope: 'application_payload_estimates_excluding_headers_tls_tcp_and_retransmits',
        deliveryGuarantee: 'at_least_once_when_log_sink_recovers',
        ...measurement,
      }));
      if (buckets.get(key) === bucket) buckets.delete(key);
      output.push(measurement);

      totalRequests += bucket.requestCount || 0;
      totalSuccessful += bucket.successfulRequests || 0;
      totalFailed += bucket.failedRequests || 0;
      const outbound = bucket.outboundRequestBodyBytes || 0;
      if (bucket.measurementKind?.startsWith('measured_')) {
        totalMeasuredOutboundBytes += outbound;
      } else {
        totalEstimatedOutboundBytes += outbound;
      }
      const inbound = bucket.responseBodyBytesReceived || 0;
      totalMeasuredInboundBytes += inbound;

      const svcKey = bucket.service || 'unknown';
      const svcStats = serviceSummary.get(svcKey) || { requests: 0, outbound: 0, inbound: 0 };
      svcStats.requests += bucket.requestCount || 0;
      svcStats.outbound += outbound;
      svcStats.inbound += inbound;
      serviceSummary.set(svcKey, svcStats);
    } catch {
      failedWrites += 1;
    }
  }

  // Consolidated periodic window summary for clean deployment log aggregation
  if (output.length > 0 && failedWrites === 0 && process.env.NODE_ENV === 'production') {
    try {
      console.info(JSON.stringify({
        level: 'info',
        event: 'outbound_bandwidth_summary',
        intervalMs: FLUSH_INTERVAL_MS,
        requests: { total: totalRequests, success: totalSuccessful, failed: totalFailed },
        payloadBytes: {
          measuredOutbound: totalMeasuredOutboundBytes,
          estimatedOutbound: totalEstimatedOutboundBytes,
          measuredInbound: totalMeasuredInboundBytes,
          totalApplicationBytes: totalMeasuredOutboundBytes + totalEstimatedOutboundBytes + totalMeasuredInboundBytes,
        },
        services: Object.fromEntries(serviceSummary),
        note: 'Covers measured application payloads; excludes TCP/TLS framing, headers and raw socket retransmissions',
      }));
    } catch {
      /* logging failure must not throw */
    }
  }

  if (failedWrites) safeMonitorLog(`flush unavailable; retaining ${failedWrites} aggregate bucket(s) for retry`);
  return output;
}

function requestDetails(protocol, args) {
  const first = args[0];
  const second = args[1];
  const options = first instanceof URL ? (second || {}) : (typeof first === 'object' && first ? first : (second || {}));
  const host = hostFrom(first, protocol);
  const method = String(options.method || 'GET').toUpperCase();
  return { host, method };
}

function addNodeRequestHooks(req, details, startedAt) {
  let requestBytes = 0;
  let requestBodyKnown = true;
  let responseBytes = null;
  let networkClass = 'unknown';
  let responseSeen = false;
  let finalized = false;
  const originalWrite = req.write;
  const originalEnd = req.end;

  req.write = function measuredWrite(chunk, encoding, callback) {
    try {
      const length = bodyLength(chunk);
      if (length === null) requestBodyKnown = false;
      else requestBytes += length;
    } catch { requestBodyKnown = false; }
    return originalWrite.call(this, chunk, encoding, callback);
  };
  req.end = function measuredEnd(chunk, encoding, callback) {
    if (typeof chunk === 'function') return originalEnd.call(this, chunk);
    if (chunk !== undefined && chunk !== null) {
      try {
        const length = bodyLength(chunk);
        if (length === null) requestBodyKnown = false;
        else requestBytes += length;
      } catch { requestBodyKnown = false; }
    }
    return originalEnd.call(this, chunk, encoding, callback);
  };

  const finish = (success, responseStatus = null) => {
    if (finalized) return;
    finalized = true;
    recordMeasurement({
      service: operationContext.getStore()?.service || serviceForHost(details.host),
      destination: details.host,
      operation: operationContext.getStore()?.operation || details.method,
      networkClass,
      requestBodyBytes: requestBodyKnown ? requestBytes : null,
    responseBodyBytes: responseBytes,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      success,
      responseStatus,
    measurementKind: responseBytes === null ? 'measured_request_unknown_response' : 'measured_request_estimated_response',
    });
  };

  req.prependListener('response', (response) => {
    responseSeen = true;
    networkClass = classifyAddress(response.socket?.remoteAddress || req.socket?.remoteAddress);
    // A content-length header is an estimate, not a guarantee. It is used so
    // the monitor never adds a data listener, wraps push(), or changes stream
    // flow/cancellation behavior merely to count response bytes.
    responseBytes = declaredContentLength(response.headers);
    response.once('end', () => finish(response.statusCode >= 200 && response.statusCode < 400, response.statusCode));
    response.once('aborted', () => finish(false, response.statusCode));
    response.once('error', () => finish(false, response.statusCode));
  });
  req.once('error', () => {
    networkClass = classifyAddress(req.socket?.remoteAddress);
    finish(false);
  });
  req.once('close', () => {
    if (!finalized && !responseSeen && req.destroyed) {
      networkClass = classifyAddress(req.socket?.remoteAddress);
      finish(false);
    }
  });
}

function patchHttpModule(module, protocol) {
  if (module.request.__outboundBandwidthWrapped) return;
  const original = module.request;
  function measuredRequest(...args) {
    const startedAt = process.hrtime.bigint();
    const details = requestDetails(protocol, args);
    const req = original.apply(this, args);
    try { addNodeRequestHooks(req, details, startedAt); } catch { /* never alter transport behavior */ }
    return req;
  }
  measuredRequest.__outboundBandwidthWrapped = true;
  module.request = measuredRequest;
  if (module.get && !module.get.__outboundBandwidthWrapped) {
    const originalGet = module.get;
    function measuredGet(...args) {
      const req = module.request(...args);
      req.end();
      return req;
    }
    measuredGet.__outboundBandwidthWrapped = true;
    module.get = measuredGet;
    measuredGet.__original = originalGet;
  }
}

function createMeasuredFetch(originalFetch) {
  return async function measuredFetch(input, init) {
    const request = init?.body !== undefined ? init.body : input?.body;
    let requestBytes = bodyLength(request);
    // Streaming bodies remain unknown unless the body itself is byte-addressable;
    // a Content-Length header is a declaration, not proof of transmitted bytes.
    const destination = hostFrom(input, 'https:');
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const startedAt = process.hrtime.bigint();
    const context = operationContext.getStore() || {};
    let networkClass = net.isIP(destination) ? classifyAddress(destination) : 'unknown';
    try {
      const response = await originalFetch(input, init);
      const responseUrl = response.url || (typeof input === 'string' ? input : input?.url);
      const responseHost = hostFrom(responseUrl || destination, 'https:');
      networkClass = classifyFetchHost(destination);
      const responseBytes = response.body ? declaredContentLength(response.headers) : 0;
      // Record at headers time and return the exact original Response. Reading
      // or teeing its body would change backpressure, cancellation, and memory
      // behavior for callers with streamed responses.
      recordMeasurement({
        service: context.service || serviceForHost(responseHost),
        destination: responseHost,
        operation: context.operation || method,
        networkClass,
        requestBodyBytes: requestBytes,
        responseBodyBytes: responseBytes,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        success: response.status >= 200 && response.status < 400,
        responseStatus: response.status,
        redirected: response.redirected === true,
        measurementSource: 'fetch_body_and_content_length',
        measurementKind: responseBytes === null ? 'measured_request_unknown_response' : 'measured_request_estimated_response',
      });
      return response;
    } catch (error) {
      recordMeasurement({
        service: context.service || serviceForHost(destination),
        destination,
        operation: context.operation || method,
        networkClass,
        requestBodyBytes: requestBytes,
        responseBodyBytes: null,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        success: false,
        measurementSource: 'fetch_body_and_content_length',
        measurementKind: 'measured_request_unknown_response',
      });
      throw error;
    }
  };
}

function installFetchHook() {
  if (typeof globalThis.fetch !== 'function' || globalThis.fetch.__outboundBandwidthWrapped) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const measuredFetch = createMeasuredFetch(originalFetch);
  measuredFetch.__outboundBandwidthWrapped = true;
  measuredFetch.__original = originalFetch;
  globalThis.fetch = measuredFetch;
}

function installOutboundBandwidthMonitoring() {
  if (installed) return;
  try { patchHttpModule(http, 'http:'); } catch { safeMonitorLog('HTTP instrumentation unavailable'); }
  try { patchHttpModule(https, 'https:'); } catch { safeMonitorLog('HTTPS instrumentation unavailable'); }
  try { installFetchHook(); } catch { safeMonitorLog('fetch instrumentation unavailable'); }
  try {
    flushTimer = setInterval(() => {
      try { flushMeasurements(); } catch { /* timer must never throw */ }
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  } catch { safeMonitorLog('flush timer unavailable'); }
  installed = true;
}

function stopOutboundBandwidthMonitoring() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushMeasurements();
}

function withOutboundOperation(service, operation, callback) {
  let safeService = 'external-http';
  let safeOperation = 'other';
  try {
    if (/^[a-z0-9_-]{1,64}$/i.test(String(service))) safeService = String(service);
    if (/^[a-z0-9_-]{1,48}$/i.test(String(operation))) safeOperation = String(operation);
  } catch { /* defaults are safe */ }
  let callbackInvoked = false;
  try {
    return operationContext.run({ service: safeService, operation: safeOperation }, () => {
      callbackInvoked = true;
      return callback();
    });
  } catch (error) {
    // Preserve synchronous business exceptions; only fall back when ALS failed
    // before it invoked the business callback.
    if (callbackInvoked) throw error;
    return callback();
  }
}

async function measureDatabaseFileParameter({ operation, fileBytes, run }) {
  return databaseMeasurementContext.run({ suppressQueryPayloadMeasurement: true }, async () => {
    const startedAt = process.hrtime.bigint();
    let success = false;
    try {
      const result = await run();
      success = true;
      return result;
    } finally {
      recordMeasurement({
        service: 'supabase-postgres',
        destination: 'database-url',
        operation,
        measurementSource: 'postgres_file_parameter',
        networkClass: 'unknown',
        requestBodyBytes: finiteBytes(fileBytes),
        responseBodyBytes: null,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        success,
        measurementKind: 'estimated_postgres_parameter_bytes',
      });
    }
  });
}

function redisArgumentBytes(value) {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function estimateRedisCommandBytes(command) {
  try {
    const values = [command?.name || '', ...(Array.isArray(command?.args) ? command.args : [])];
    return values.reduce((total, value) => {
      const bytes = redisArgumentBytes(value);
      // RESP array framing plus bulk-string length framing. This is an
      // application-level estimate; it intentionally never serializes/logs data.
      return total + bytes + Buffer.byteLength(String(bytes)) + 5;
    }, Buffer.byteLength(String(values.length)) + 4);
  } catch {
    return null;
  }
}

function estimateRedisResponseBytes(value, depth = 0) {
  try {
    if (depth > 3) return null;
    if (value == null) return 5;
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength + 8;
    if (typeof value === 'string' || typeof value === 'number') return Buffer.byteLength(String(value)) + 3;
    if (Array.isArray(value) && value.length <= 256) {
      let total = Buffer.byteLength(String(value.length)) + 4;
      for (const item of value) {
        const bytes = estimateRedisResponseBytes(item, depth + 1);
        if (bytes === null) return null;
        total += bytes;
      }
      return total;
    }
    return null;
  } catch {
    return null;
  }
}

function instrumentRedisClient(client) {
  if (!client || client.sendCommand?.__outboundBandwidthWrapped) return client;
  try {
    const original = client.sendCommand;
    function measuredSendCommand(command, stream) {
      const startedAt = process.hrtime.bigint();
      const requestBodyBytes = estimateRedisCommandBytes(command);
      const operation = /^[a-z0-9_-]{1,48}$/i.test(String(command?.name || ''))
        ? String(command.name).toLowerCase()
        : 'command';
      let result;
      try {
        result = original.call(this, command, stream);
      } catch (error) {
        recordMeasurement({ service: 'redis', destination: 'redis', operation, measurementSource: 'redis_resp_estimate', measurementKind: 'estimated_redis_protocol_bytes', networkClass: classifyAddress(this.stream?.remoteAddress), requestBodyBytes, responseBodyBytes: null, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6, success: false });
        throw error;
      }
      Promise.resolve(result).then(
        (value) => recordMeasurement({ service: 'redis', destination: 'redis', operation, measurementSource: 'redis_resp_estimate', measurementKind: 'estimated_redis_protocol_bytes', networkClass: classifyAddress(this.stream?.remoteAddress), requestBodyBytes, responseBodyBytes: estimateRedisResponseBytes(value), durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6, success: true }),
        () => recordMeasurement({ service: 'redis', destination: 'redis', operation, measurementSource: 'redis_resp_estimate', measurementKind: 'estimated_redis_protocol_bytes', networkClass: classifyAddress(this.stream?.remoteAddress), requestBodyBytes, responseBodyBytes: null, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6, success: false }),
      ).catch(() => {});
      return result;
    }
    measuredSendCommand.__outboundBandwidthWrapped = true;
    client.sendCommand = measuredSendCommand;
    if (typeof client.duplicate === 'function' && !client.duplicate.__outboundBandwidthWrapped) {
      const originalDuplicate = client.duplicate;
      function measuredDuplicate(...args) {
        return instrumentRedisClient(originalDuplicate.apply(this, args));
      }
      measuredDuplicate.__outboundBandwidthWrapped = true;
      client.duplicate = measuredDuplicate;
    }
  } catch {
    safeMonitorLog('Redis instrumentation unavailable');
  }
  return client;
}

function estimatePostgresValueBytes(value, state = { remaining: 4096 }) {
  try {
    if (state.remaining-- <= 0) return null;
    if (value == null) return 4;
    // Binary values are intentionally not estimated here: dedicated file
    // measurements provide their payload size without double-counting them.
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) return Buffer.byteLength(String(value), 'utf8');
    if (Array.isArray(value)) {
      let total = 2;
      for (const item of value) {
        const bytes = estimatePostgresValueBytes(item, state);
        if (bytes === null) return null;
        total += bytes + 1;
      }
      return total;
    }
    // Do not invoke toJSON(), getters, or custom serialization on application
    // objects merely for telemetry. Their database representation is unknown.
    if (typeof value === 'object') return null;
    return Buffer.byteLength(String(value), 'utf8');
  } catch {
    return null;
  }
}

function postgresOperation(text) {
  try {
    const sql = typeof text === 'string' ? text : text?.text;
    const match = String(sql || '').trim().match(/^([a-z]+)/i);
    const operation = String(match?.[1] || 'query').toLowerCase();
    return /^(select|insert|update|delete|begin|commit|rollback|set|show|with)$/.test(operation) ? operation : 'query';
  } catch {
    return 'query';
  }
}

function estimatePostgresRequestBytes(text, values) {
  try {
    const sql = typeof text === 'string' ? text : text?.text;
    let total = Buffer.byteLength(String(sql || ''), 'utf8');
    const parameters = values ?? (typeof text === 'object' ? text.values : undefined);
    if (!parameters) return total;
    const list = Array.isArray(parameters) ? parameters : [parameters];
    for (const value of list) {
      const bytes = estimatePostgresValueBytes(value);
      if (bytes === null) return null;
      total += bytes;
    }
    return total;
  } catch {
    return null;
  }
}

function observePostgresQuery({ text, values, run }) {
  if (databaseMeasurementContext.getStore()?.suppressQueryPayloadMeasurement) return run();
  const startedAt = process.hrtime.bigint();
  const requestBodyBytes = estimatePostgresRequestBytes(text, values);
  const operation = postgresOperation(text);
  const record = (success) => recordMeasurement({
    service: 'supabase-postgres',
    destination: 'database-url',
    operation,
    measurementSource: 'postgres_query_payload_estimate',
    measurementKind: 'estimated_postgres_query_bytes_excluding_binary_parameters',
    networkClass: 'unknown',
    requestBodyBytes,
    // pg exposes decoded row objects rather than protocol frames. Estimating
    // them would be both expensive and misleading, so received bytes remain
    // explicitly unknown.
    responseBodyBytes: null,
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    success,
  });
  let result;
  try {
    result = run();
  } catch (error) {
    record(false);
    throw error;
  }
  Promise.resolve(result).then(() => record(true), () => record(false)).catch(() => {});
  return result;
}

module.exports = {
  classifyAddress,
  classifyFetchHost,
  createMeasuredFetch,
  flushMeasurements,
  instrumentRedisClient,
  observePostgresQuery,
  installOutboundBandwidthMonitoring,
  stopOutboundBandwidthMonitoring,
  measureDatabaseFileParameter,
  recordMeasurement,
  observeHttpRequest: addNodeRequestHooks,
  withOutboundOperation,
};
