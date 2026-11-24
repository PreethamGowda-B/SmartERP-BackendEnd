'use strict';

function shouldStartBackgroundWorkers({ isClusterWorker, isPrimaryWorker, nodeEnv }) {
  if (process.env.ENABLE_BACKGROUND_WORKERS === 'false') return false;
  if (isClusterWorker) return isPrimaryWorker === true || isPrimaryWorker === 'true';
  return nodeEnv !== 'production';
}

module.exports = { shouldStartBackgroundWorkers };
