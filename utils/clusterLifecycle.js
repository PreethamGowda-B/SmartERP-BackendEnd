'use strict';

function createClusterLifecycle({ cluster, processRef = process, logger = console, shutdownTimeoutMs = 15_000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let shuttingDown = false;
  let started = false;
  let shutdownPromise = null;
  let resolveShutdown = null;
  let shutdownTimer = null;
  let backgroundWorkerId = null;
  const workers = new Map();

  function completeShutdown(exitCode) {
    if (shutdownTimer) {
      clearTimer(shutdownTimer);
      shutdownTimer = null;
    }
    processRef.exitCode = exitCode;
    const resolve = resolveShutdown;
    resolveShutdown = null;
    resolve?.(exitCode);
    processRef.exit?.(exitCode);
  }

  function log(level, message, metadata) {
    try { logger[level]?.(message, metadata); } catch { /* lifecycle logging must not prevent shutdown */ }
  }

  function spawn(background) {
    if (shuttingDown) return null;
    const worker = cluster.fork({ IS_PRIMARY_WORKER: background ? 'true' : 'false' });
    workers.set(worker.id, { worker, background });
    if (background) backgroundWorkerId = worker.id;
    log('info', 'Cluster worker started', { workerId: worker.id, background });
    return worker;
  }

  function onExit(worker, code, signal) {
    const tracked = workers.get(worker.id);
    workers.delete(worker.id);
    const wasBackground = tracked?.background === true || worker.id === backgroundWorkerId;
    if (worker.id === backgroundWorkerId) backgroundWorkerId = null;

    if (shuttingDown) {
      if (workers.size === 0) {
        completeShutdown(0);
      }
      return;
    }

    log('warn', 'Cluster worker exited; starting replacement', {
      workerId: worker.id,
      code,
      signal,
      background: wasBackground,
    });
    spawn(wasBackground);
  }

  function requestShutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    log('info', 'Cluster master shutting down', { signal });
    shutdownPromise = new Promise((resolve) => {
      resolveShutdown = resolve;

      if (workers.size === 0) {
        completeShutdown(0);
        return;
      }

      shutdownTimer = setTimer(() => {
        log('error', 'Cluster worker shutdown timed out; forcing termination', { workerCount: workers.size });
        for (const { worker } of workers.values()) {
          try { worker.process?.kill?.('SIGKILL'); } catch { /* process may have exited */ }
        }
        completeShutdown(1);
      }, shutdownTimeoutMs);

      for (const { worker } of workers.values()) {
        try { worker.process?.kill?.('SIGTERM'); } catch { /* exit event or timeout handles it */ }
      }
    });
    return shutdownPromise;
  }

  function install() {
    if (started) return;
    started = true;
    cluster.on('exit', onExit);
    processRef.on('SIGTERM', () => { void requestShutdown('SIGTERM'); });
    processRef.on('SIGINT', () => { void requestShutdown('SIGINT'); });
  }

  function start(workerCount) {
    install();
    if (shuttingDown) return [];
    return Array.from({ length: Math.max(0, Math.floor(workerCount)) }, (_, index) => spawn(index === 0)).filter(Boolean);
  }

  return {
    install,
    start,
    requestShutdown,
    isShuttingDown: () => shuttingDown,
    getWorkers: () => [...workers.values()].map(({ worker, background }) => ({ id: worker.id, background })),
    getBackgroundWorkerId: () => backgroundWorkerId,
  };
}

module.exports = { createClusterLifecycle };
