const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  SUBSCRIPTION_PLANS,
  resolvePlanTier,
  isUnlimitedPlan,
  getEmployeeLimit,
  getPlanLimit,
  getPricePaise,
  verifyCheckoutSignature,
  paymentMatchesOrder
} = require('../services/subscriptionCatalog');

test('canonical plan catalog contains the approved customer prices and stable IDs', () => {
  assert.deepEqual(
    Object.values(SUBSCRIPTION_PLANS).map(({ key, name, priceMonthly, priceYearly, employeeLimit }) => ({ key, name, priceMonthly, priceYearly, employeeLimit })),
    [
      { key: 'starter', name: 'Starter', priceMonthly: 0, priceYearly: 0, employeeLimit: 10 },
      { key: 'professional', name: 'Professional', priceMonthly: 999, priceYearly: 9990, employeeLimit: 50 },
      { key: 'enterprise', name: 'Enterprise', priceMonthly: 2499, priceYearly: 24990, employeeLimit: null }
    ]
  );
  assert.equal(getPricePaise(2, 'monthly'), 99900);
  assert.equal(getPricePaise(2, 'yearly'), 999000);
  assert.equal(getPricePaise(3, 'yearly'), 2499000);
  assert.equal(getPricePaise(3, 'quarterly'), null);
  assert.equal(resolvePlanTier({ id: 1, name: 'Starter' }), 'starter');
  assert.equal(resolvePlanTier({ id: 2, name: 'Professional' }), 'professional');
  assert.equal(resolvePlanTier({ id: 3, name: 'Enterprise' }), 'enterprise');
  assert.equal(resolvePlanTier({ id: 0, name: 'Super Admin' }), 'enterprise');
  assert.equal(resolvePlanTier({ id: 99, name: 'Unknown' }), null);
  assert.equal(isUnlimitedPlan({ id: 2, name: 'Professional' }), false);
  assert.equal(isUnlimitedPlan({ id: 3, name: 'Enterprise' }), true);
  assert.equal(getEmployeeLimit(1), 10);
  assert.equal(getEmployeeLimit(2), 50);
  assert.equal(getEmployeeLimit(3), null);
  assert.equal(getEmployeeLimit(99), undefined);
  assert.equal(getPlanLimit(1, 'activeJobsLimit'), 15);
  assert.equal(getPlanLimit(2, 'inventoryItemsLimit'), 500);
  assert.equal(getPlanLimit(2, 'storageBytesLimit'), 5 * 1024 * 1024 * 1024);
  assert.equal(getPlanLimit(3, 'activeJobsLimit'), null);
  assert.equal(getPlanLimit(99, 'activeJobsLimit'), undefined);
});

test('checkout signature verification is timing-safe and rejects malformed or forged input', () => {
  const secret = 'test-only-secret';
  const orderId = 'order_test_123';
  const paymentId = 'pay_test_456';
  const signature = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature, secret }), true);
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature: 'f'.repeat(64), secret }), false);
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature: 'not-hex', secret }), false);
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature, secret: '' }), false);
});

test('captured payment must match provider order, company, purpose, plan, cycle, INR amount', () => {
  const order = { id: 'order_1', amount: 99900, currency: 'INR', notes: { companyId: 'company-a', purpose: 'plan_purchase', planId: '2', billingCycle: 'monthly' } };
  const payment = { id: 'pay_1', order_id: 'order_1', amount: 99900, currency: 'INR', status: 'captured' };
  const expected = { order, payment, companyId: 'company-a', purpose: 'plan_purchase', planId: 2, billingCycle: 'monthly', expectedAmountPaise: 99900 };
  assert.equal(paymentMatchesOrder(expected), true);
  assert.equal(paymentMatchesOrder({ ...expected, companyId: 'company-b' }), false);
  assert.equal(paymentMatchesOrder({ ...expected, expectedAmountPaise: 100 }), false);
  assert.equal(paymentMatchesOrder({ ...expected, payment: { ...payment, status: 'authorized' } }), false);
  assert.equal(paymentMatchesOrder({ ...expected, payment: { ...payment, currency: 'USD' } }), false);
  assert.equal(paymentMatchesOrder({ ...expected, purpose: 'trial_activation' }), false);
});

test('trial checkout is one-time ₹1 with a separate purpose from paid-plan purchase', () => {
  const order = { id: 'order_trial', amount: 100, currency: 'INR', notes: { companyId: 'company-a', purpose: 'trial_activation', planId: '3', billingCycle: 'trial' } };
  const payment = { id: 'pay_trial', order_id: 'order_trial', amount: 100, currency: 'INR', status: 'captured' };
  assert.equal(paymentMatchesOrder({ order, payment, companyId: 'company-a', purpose: 'trial_activation', planId: 3, billingCycle: 'trial', expectedAmountPaise: 100 }), true);
  assert.equal(paymentMatchesOrder({ order, payment: { ...payment, amount: 1000 }, companyId: 'company-a', purpose: 'trial_activation', planId: 3, billingCycle: 'trial', expectedAmountPaise: 100 }), false);
});
