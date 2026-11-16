'use strict';

function registerWorkerShutdown({
  processRef = process,
  getServer = () => null,
  stopProcessors = async () => {},
  closeMonitoring = () => {},
  closeDatabase = async () => {},
  closeRedis = async () => {},
  logger = console,
  timeoutMs = 15_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let shutdownPromise = null;
  let timeout = null;
  const safeLog = (level, message, metadata) => {
    try { logger[level]?.(message, metadata); } catch { /* logging cannot prevent shutdown */ }
  };

  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      safeLog('info', 'Worker graceful shutdown started', { signal });
      timeout = setTimer(() => {
        safeLog('error', 'Worker shutdown timed out; forcing termination', { signal });
        processRef.exit(1);
      }, timeoutMs);
      timeout?.unref?.();

      try { await stopProcessors(); } catch (error) { safeLog('warn', 'Processor shutdown failed', { error: error?.message }); }
      const server = getServer();
      if (server?.listening) {
        await new Promise((resolve) => {
          try { server.close(resolve); } catch { resolve(); }
        });
      }
      try { closeMonitoring(); } catch { /* instrumentation is optional */ }
      try { await closeDatabase(); } catch (error) { safeLog('warn', 'Database close failed', { error: error?.message }); }
      try { await closeRedis(); } catch (error) { safeLog('warn', 'Redis close failed', { error: error?.message }); }
      if (timeout) clearTimer(timeout);
      timeout = null;
      safeLog('info', 'Worker graceful shutdown complete');
      processRef.exit(0);
    })();
    return shutdownPromise;
  };

  processRef.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  processRef.on('SIGINT', () => { void shutdown('SIGINT'); });
  return { shutdown, isShuttingDown: () => shutdownPromise !== null };
}

module.exports = { registerWorkerShutdown };
