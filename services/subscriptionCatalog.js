const PLAN_FEATURES = Object.freeze({
  starter: Object.freeze({
    payroll: false,
    messages: true,
    ai_assistant: false,
    basic_reports: true,
    export_reports: true,
    advanced_reports: false,
    inventory_images: false,
    priority_support: false,
    location_tracking: false,
    ar_collections: false,
    inventory_forecasts: false
  }),
  professional: Object.freeze({
    payroll: true,
    messages: true,
    ai_assistant: true,
    basic_reports: true,
    export_reports: true,
    advanced_reports: true,
    inventory_images: true,
    priority_support: false,
    location_tracking: true,
    ar_collections: true,
    inventory_forecasts: true
  }),
  enterprise: Object.freeze({
    payroll: true,
    messages: true,
    ai_assistant: true,
    basic_reports: true,
    export_reports: true,
    advanced_reports: true,
    inventory_images: true,
    priority_support: false,
    location_tracking: true,
    ar_collections: true,
    inventory_forecasts: true
  })
});

const SUBSCRIPTION_PLANS = Object.freeze({
  1: Object.freeze({ key: 'starter', name: 'Starter', priceMonthly: 0, priceYearly: 0, employeeLimit: 10, activeJobsLimit: 15, inventoryItemsLimit: 50, storageBytesLimit: 250 * 1024 * 1024, features: PLAN_FEATURES.starter }),
  2: Object.freeze({ key: 'professional', name: 'Professional', priceMonthly: 999, priceYearly: 9990, employeeLimit: 50, activeJobsLimit: 100, inventoryItemsLimit: 500, storageBytesLimit: 5 * 1024 * 1024 * 1024, features: PLAN_FEATURES.professional }),
  3: Object.freeze({ key: 'enterprise', name: 'Enterprise', priceMonthly: 2499, priceYearly: 24990, employeeLimit: null, activeJobsLimit: null, inventoryItemsLimit: null, storageBytesLimit: null, features: PLAN_FEATURES.enterprise })
});

function getPlan(planId) {
  return SUBSCRIPTION_PLANS[Number(planId)] || null;
}

function applyCanonicalPlanFeatures(plan) {
  if (!plan) return plan;
  const canonicalPlan = getPlan(plan.id || plan.plan_db_id || plan.plan_id);
  if (!canonicalPlan) return plan;
  return {
    ...plan,
    plan_key: canonicalPlan.key,
    name: canonicalPlan.name,
    employee_limit: canonicalPlan.employeeLimit,
    features: canonicalPlan.features
  };
}

function resolvePlanTier(plan) {
  const planId = Number(plan?.id ?? plan?.plan_db_id);
  if (planId === 0) return 'enterprise'; // Internal Super Admin sentinel, not a customer plan.
  if (planId === 3) return 'enterprise';
  if (planId === 2) return 'professional';
  if (planId === 1) return 'starter';
  return null;
}

function isUnlimitedPlan(plan) {
  return resolvePlanTier(plan) === 'enterprise';
}

function getEmployeeLimit(planId) {
  const plan = getPlan(planId);
  return plan ? plan.employeeLimit : undefined;
}

function getPlanLimit(planId, limitName) {
  const plan = getPlan(planId);
  return plan && Object.hasOwn(plan, limitName) ? plan[limitName] : undefined;
}

function getPricePaise(planId, billingCycle) {
  const plan = getPlan(planId);
  if (!plan || !['monthly', 'yearly'].includes(billingCycle)) return null;
  return Math.round((billingCycle === 'yearly' ? plan.priceYearly : plan.priceMonthly) * 100);
}

function isRazorpayConfigured(env = process.env) {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

function verifyCheckoutSignature({ orderId, paymentId, signature, secret }) {
  if (!orderId || !paymentId || !signature || !secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function paymentMatchesOrder({ order, payment, companyId, purpose, planId, billingCycle, expectedAmountPaise }) {
  if (!order || !payment || payment.status !== 'captured') return false;
  if (String(payment.order_id) !== String(order.id)) return false;
  if (Number(payment.amount) !== Number(expectedAmountPaise) || Number(order.amount) !== Number(expectedAmountPaise)) return false;
  if (payment.currency !== 'INR' || order.currency !== 'INR') return false;
  const notes = order.notes || {};
  if (String(notes.companyId) !== String(companyId) || notes.purpose !== purpose) return false;
  if (planId != null && Number(notes.planId) !== Number(planId)) return false;
  if (billingCycle && notes.billingCycle !== billingCycle) return false;
  return true;
}

module.exports = { PLAN_FEATURES, SUBSCRIPTION_PLANS, getPlan, applyCanonicalPlanFeatures, resolvePlanTier, isUnlimitedPlan, getEmployeeLimit, getPlanLimit, getPricePaise, isRazorpayConfigured, verifyCheckoutSignature, paymentMatchesOrder };
