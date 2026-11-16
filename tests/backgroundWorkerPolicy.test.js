'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldStartBackgroundWorkers } = require('../utils/backgroundWorkerPolicy');

test('only the designated production cluster worker starts background processors', () => {
  assert.equal(shouldStartBackgroundWorkers({ isClusterWorker: true, isPrimaryWorker: 'true', nodeEnv: 'production' }), true);
  assert.equal(shouldStartBackgroundWorkers({ isClusterWorker: true, isPrimaryWorker: 'false', nodeEnv: 'production' }), false);
  assert.equal(shouldStartBackgroundWorkers({ isClusterWorker: true, isPrimaryWorker: undefined, nodeEnv: 'production' }), false);
});

test('single non-production process retains local background processing', () => {
  assert.equal(shouldStartBackgroundWorkers({ isClusterWorker: false, nodeEnv: 'development' }), true);
});

test('single production process does not accidentally start a duplicate worker set', () => {
  assert.equal(shouldStartBackgroundWorkers({ isClusterWorker: false, nodeEnv: 'production' }), false);
});
