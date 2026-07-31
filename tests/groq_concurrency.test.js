const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncConcurrencyLimiter } = require('../utils/asyncLimiter');

test.describe('Groq API Concurrency Limiter Load Test', () => {

  test('Limiter throttles 50 concurrent calls to max 5 at a time', async () => {
    const limiter = new AsyncConcurrencyLimiter(5); // Concurrency cap = 5
    let maxObservedActive = 0;
    const completedTimestamps = [];

    const mockGroqCall = async (id) => {
      return limiter.run(async () => {
        if (limiter.stats.activeCount > maxObservedActive) {
          maxObservedActive = limiter.stats.activeCount;
        }
        // Simulate Groq network API latency (50ms)
        await new Promise((res) => setTimeout(res, 50));
        completedTimestamps.push(Date.now());
        return `response-${id}`;
      });
    };

    const startTime = Date.now();
    const tasks = Array.from({ length: 50 }, (_, i) => mockGroqCall(i + 1));
    const results = await Promise.all(tasks);
    const totalDurationMs = Date.now() - startTime;

    // Verification 1: All 50 calls finished successfully
    assert.equal(results.length, 50);
    assert.equal(results[0], 'response-1');
    assert.equal(results[49], 'response-50');

    // Verification 2: Maximum concurrent calls NEVER exceeded cap of 5
    assert.ok(maxObservedActive <= 5, `Max observed active (${maxObservedActive}) exceeded cap of 5`);

    // Verification 3: Total duration proves staggering (50 calls / 5 per batch * 50ms >= 500ms)
    assert.ok(totalDurationMs >= 450, `Total duration (${totalDurationMs}ms) indicates no throttling occurred`);

    console.log(`\n[Groq Concurrency Limiter Verification]`);
    console.log(`Total Requests: 50`);
    console.log(`Concurrency Cap: 5`);
    console.log(`Peak Concurrent Active Requests: ${maxObservedActive}`);
    console.log(`Total Execution Time: ${totalDurationMs}ms`);
    console.log(`Batch Staggering Proved: YES\n`);
  });

});
