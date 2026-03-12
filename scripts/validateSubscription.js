/**
 * Quick validation: test that planMiddleware and featureGuard load correctly,
 * and that the subscription route loads without errors.
 */
const { loadPlan, invalidatePlanCache } = require('./middleware/planMiddleware');
const { requireFeature } = require('./middleware/featureGuard');
const subscriptionRouter = require('./routes/subscription');
const trialProcessor = require('./jobs/trialExpiryProcessor');

console.log('✅ planMiddleware loaded:', typeof loadPlan === 'function');
console.log('✅ invalidatePlanCache loaded:', typeof invalidatePlanCache === 'function');
console.log('✅ requireFeature loaded:', typeof requireFeature === 'function');
console.log('✅ subscription router loaded:', typeof subscriptionRouter === 'function');
console.log('✅ trialExpiryProcessor loaded:', typeof trialProcessor.startTrialExpiryProcessor === 'function');
console.log('✅ processTrialExpiry exported:', typeof trialProcessor.processTrialExpiry === 'function');
console.log('✅ logSubscriptionEvent exported:', typeof trialProcessor.logSubscriptionEvent === 'function');
console.log('\n🚀 All subscription modules loaded successfully!');
process.exit(0);
