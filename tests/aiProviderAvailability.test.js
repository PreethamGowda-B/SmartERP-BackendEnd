const test = require('node:test');
const assert = require('node:assert/strict');
const GroqProvider = require('../ai/providers/groq.provider');

test('Groq provider reports missing server configuration as an explicit 503', () => {
  const previousKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  try {
    assert.throws(() => new GroqProvider(), (error) => {
      assert.equal(error.code, 'AI_PROVIDER_NOT_CONFIGURED');
      assert.equal(error.statusCode, 503);
      return true;
    });
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  }
});

test('Groq provider bounds model failover and reports provider failures as a safe 503', async () => {
  const previousKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key-not-used-for-network';

  try {
    const provider = new GroqProvider();
    const modelAttempts = [];
    provider.client.chat.completions.create = async ({ model }) => {
      modelAttempts.push(model);
      const error = new Error('simulated provider outage');
      error.code = 'simulated_outage';
      throw error;
    };

    await assert.rejects(
      provider.generateCompletion({ messages: [{ role: 'user', content: 'hello' }] }),
      (error) => {
        assert.equal(error.code, 'AI_PROVIDER_UNAVAILABLE');
        assert.equal(error.statusCode, 503);
        assert.equal(error.providerErrorCode, 'simulated_outage');
        assert.equal(error.message.includes('simulated provider outage'), false);
        return true;
      }
    );
    assert.equal(modelAttempts.length, 2);
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  }
});

test('Groq provider does not try other models after account quota is exhausted', async () => {
  const previousKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key-not-used-for-network';

  try {
    const provider = new GroqProvider();
    const modelAttempts = [];
    provider.client.chat.completions.create = async ({ model }) => {
      modelAttempts.push(model);
      const error = new Error('simulated rate limit');
      error.status = 429;
      error.code = 'rate_limit_exceeded';
      throw error;
    };

    await assert.rejects(
      provider.generateCompletion({ messages: [{ role: 'user', content: 'test' }] }),
      (error) => error.code === 'AI_PROVIDER_UNAVAILABLE' && error.statusCode === 503
    );
    assert.equal(modelAttempts.length, 1);
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  }
});

test('Groq client retries are disabled to avoid multiplying prompt latency', () => {
  const previousKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key-not-used-for-network';

  try {
    const provider = new GroqProvider();
    assert.equal(provider.client.maxRetries, 0);
    assert.equal(provider.client.timeout, 10000);
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  }
});
