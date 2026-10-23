class AsyncConcurrencyLimiter {
  constructor(concurrency = 5, { maxQueue = Infinity, maxQueueWaitMs = 0 } = {}) {
    this.concurrency = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 5;
    this.maxQueue = Number.isInteger(maxQueue) && maxQueue >= 0 ? maxQueue : Infinity;
    this.maxQueueWaitMs = Number.isInteger(maxQueueWaitMs) && maxQueueWaitMs >= 0 ? maxQueueWaitMs : 0;
    this.activeCount = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.activeCount >= this.concurrency) {
      if (this.queue.length >= this.maxQueue) {
        const error = new Error('AI provider is at capacity. Retry shortly.');
        error.code = 'AI_PROVIDER_BUSY';
        error.statusCode = 503;
        throw error;
      }
      await new Promise((resolve, reject) => {
        const entry = { resolve: null, reject: null, timer: null };
        entry.resolve = () => {
          if (entry.timer) clearTimeout(entry.timer);
          resolve();
        };
        entry.reject = reject;
        if (this.maxQueueWaitMs > 0) {
          entry.timer = setTimeout(() => {
            const index = this.queue.indexOf(entry);
            if (index !== -1) this.queue.splice(index, 1);
            const error = new Error('AI provider capacity wait expired. Retry shortly.');
            error.code = 'AI_PROVIDER_QUEUE_TIMEOUT';
            error.statusCode = 503;
            reject(error);
          }, this.maxQueueWaitMs);
        }
        this.queue.push(entry);
      });
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next.resolve();
      }
    }
  }

  get stats() {
    return { activeCount: this.activeCount, pendingCount: this.queue.length };
  }
}

// Global shared Groq Rate Limiter instance (Default concurrency: 5)
function positiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

const groqConcurrencyLimiter = new AsyncConcurrencyLimiter(
  positiveInteger(process.env.GROQ_MAX_CONCURRENCY, 5, 20),
  {
    maxQueue: positiveInteger(process.env.GROQ_MAX_PENDING, 100, 10000),
    maxQueueWaitMs: positiveInteger(process.env.GROQ_QUEUE_WAIT_MS, 15000, 120000),
  }
);

module.exports = {
  AsyncConcurrencyLimiter,
  groqConcurrencyLimiter,
};
