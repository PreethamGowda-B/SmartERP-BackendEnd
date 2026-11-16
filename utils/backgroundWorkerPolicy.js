'use strict';

function shouldStartBackgroundWorkers({ isClusterWorker, isPrimaryWorker, nodeEnv }) {
  if (isClusterWorker) return isPrimaryWorker === true || isPrimaryWorker === 'true';
  return nodeEnv !== 'production';
}

module.exports = { shouldStartBackgroundWorkers };
