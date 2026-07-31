class AsyncConcurrencyLimiter {
  constructor(concurrency = 5) {
    this.concurrency = concurrency;
    this.activeCount = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.activeCount >= this.concurrency) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }

  get stats() {
    return { activeCount: this.activeCount, pendingCount: this.queue.length };
  }
}

// Global shared Groq Rate Limiter instance (Default concurrency: 5)
const groqConcurrencyLimiter = new AsyncConcurrencyLimiter(
  parseInt(process.env.GROQ_MAX_CONCURRENCY || '5', 10)
);

module.exports = {
  AsyncConcurrencyLimiter,
  groqConcurrencyLimiter,
};
