'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createClusterLifecycle } = require('../utils/clusterLifecycle');
const { registerWorkerShutdown } = require('../utils/workerShutdown');

function fixture(options = {}) {
  const cluster = new EventEmitter();
  let nextId = 1;
  const spawned = [];
  const signalHandlers = new Map();
  const exits = [];
  let timerCallback;
  const processRef = {
    exitCode: null,
    on(signal, handler) { signalHandlers.set(signal, handler); },
    exit(code) { exits.push(code); },
  };
  cluster.fork = (env) => {
    const calls = [];
    const worker = {
      id: nextId++,
      process: { kill(signal) { calls.push(signal); } },
      signals: calls,
      env,
    };
    spawned.push(worker);
    return worker;
  };
  const lifecycle = createClusterLifecycle({
    cluster,
    processRef,
    logger: { info() {}, warn() {}, error() {} },
    shutdownTimeoutMs: 10,
    setTimer(callback) { timerCallback = callback; return { callback }; },
    clearTimer() { timerCallback = null; },
    ...options,
  });
  return {
    lifecycle,
    cluster,
    spawned,
    exits,
    processRef,
    signalHandlers,
    fireTimeout: () => timerCallback?.(),
  };
}

test('primary worker crash is replaced with the processor designation', () => {
  const f = fixture();
  const [primary, secondary] = f.lifecycle.start(2);
  f.cluster.emit('exit', primary, 1, null);
  assert.equal(f.spawned.length, 3);
  assert.equal(f.spawned[2].env.IS_PRIMARY_WORKER, 'true');
  assert.equal(f.lifecycle.getBackgroundWorkerId(), f.spawned[2].id);
  assert.equal(secondary.env.IS_PRIMARY_WORKER, 'false');
});

test('secondary worker crash is replaced as a secondary', () => {
  const f = fixture();
  const [primary, secondary] = f.lifecycle.start(2);
  f.cluster.emit('exit', secondary, 1, null);
  assert.equal(f.spawned.length, 3);
  assert.equal(f.spawned[2].env.IS_PRIMARY_WORKER, 'false');
  assert.equal(f.lifecycle.getBackgroundWorkerId(), primary.id);
});

test('primary and secondary exits in the same turn still leave one designated replacement', () => {
  const f = fixture();
  const [primary, secondary] = f.lifecycle.start(2);
  f.cluster.emit('exit', primary, 1, null);
  f.cluster.emit('exit', secondary, 1, null);
  assert.deepEqual(f.spawned.slice(2).map((worker) => worker.env.IS_PRIMARY_WORKER), ['true', 'false']);
  assert.equal(f.spawned.filter((worker) => worker.env.IS_PRIMARY_WORKER === 'true').length, 2); // one exited, one live
});

test('master shutdown marks the lifecycle before signaling workers and suppresses replacement', async () => {
  const f = fixture();
  const workers = f.lifecycle.start(2);
  f.signalHandlers.get('SIGTERM')();
  assert.equal(f.lifecycle.isShuttingDown(), true);
  assert.deepEqual(workers.map((worker) => worker.signals), [['SIGTERM'], ['SIGTERM']]);
  f.cluster.emit('exit', workers[0], 0, 'SIGTERM');
  f.cluster.emit('exit', workers[1], 0, 'SIGTERM');
  assert.equal(f.spawned.length, 2);
  assert.deepEqual(f.exits, [0]);
  await Promise.resolve();
});

test('repeated shutdown signals initiate termination only once', () => {
  const f = fixture();
  const workers = f.lifecycle.start(2);
  f.signalHandlers.get('SIGTERM')();
  f.signalHandlers.get('SIGINT')();
  assert.deepEqual(workers.map((worker) => worker.signals), [['SIGTERM'], ['SIGTERM']]);
});

test('shutdown timeout forces remaining workers down and exits unsuccessfully', () => {
  const f = fixture();
  const workers = f.lifecycle.start(2);
  f.signalHandlers.get('SIGTERM')();
  f.fireTimeout();
  assert.deepEqual(workers.map((worker) => worker.signals), [['SIGTERM', 'SIGKILL'], ['SIGTERM', 'SIGKILL']]);
  assert.deepEqual(f.exits, [1]);
});

test('replacement designation survives a primary crash followed by a secondary crash', () => {
  const f = fixture();
  const [primary, secondary] = f.lifecycle.start(2);
  f.cluster.emit('exit', primary, 1, null);
  const replacementPrimary = f.spawned[2];
  f.cluster.emit('exit', secondary, 1, null);
  assert.equal(f.spawned[3].env.IS_PRIMARY_WORKER, 'false');
  assert.equal(f.lifecycle.getBackgroundWorkerId(), replacementPrimary.id);
});

test('lifecycle will not fork after shutdown starts, even if start is called again', () => {
  const f = fixture();
  const workers = f.lifecycle.start(2);
  f.signalHandlers.get('SIGTERM')();
  assert.deepEqual(f.lifecycle.start(2), []);
  for (const worker of workers) f.cluster.emit('exit', worker, 0, 'SIGTERM');
  assert.equal(f.spawned.length, 2);
});

for (const role of ['primary', 'secondary']) {
  test(`${role} worker stops processors, drains HTTP, closes dependencies, and exits once`, async () => {
    const processRef = new EventEmitter();
    const exits = [];
    processRef.exit = (code) => exits.push(code);
    const calls = [];
    const server = {
      listening: true,
      close(callback) { calls.push('http'); this.listening = false; callback(); },
    };
    const shutdown = registerWorkerShutdown({
      processRef,
      getServer: () => server,
      stopProcessors: async () => calls.push('processors'),
      closeMonitoring: () => calls.push('monitoring'),
      closeDatabase: async () => calls.push('database'),
      closeRedis: async () => calls.push('redis'),
      logger: { info() {}, warn() {}, error() {} },
      setTimer: () => ({ unref() {} }),
      clearTimer() {},
    });

    processRef.emit('SIGTERM');
    processRef.emit('SIGINT');
    await shutdown.shutdown('SIGTERM');
    assert.deepEqual(calls, ['processors', 'http', 'monitoring', 'database', 'redis']);
    assert.deepEqual(exits, [0]);
    assert.equal(shutdown.isShuttingDown(), true);
  });
}

test('worker shutdown timeout forces a non-zero exit', () => {
  const processRef = new EventEmitter();
  const exits = [];
  let timeoutCallback;
  processRef.exit = (code) => exits.push(code);
  registerWorkerShutdown({
    processRef,
    stopProcessors: () => new Promise(() => {}),
    logger: { info() {}, warn() {}, error() {} },
    setTimer(callback) { timeoutCallback = callback; return {}; },
    clearTimer() {},
  });
  processRef.emit('SIGTERM');
  timeoutCallback();
  assert.deepEqual(exits, [1]);
});
