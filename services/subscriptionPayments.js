'use strict';

async function recordPendingSubscriptionPayment(client, payment) {
  const result = await client.query(
    `INSERT INTO subscription_payments
       (company_id, purpose, plan_id, billing_cycle, razorpay_order_id,
        amount_paise, currency, status, provider_status, provider_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'created',$8,$9::jsonb)
     ON CONFLICT (razorpay_order_id) DO NOTHING
     RETURNING id`,
    [payment.companyId, payment.purpose, payment.planId, payment.billingCycle,
      payment.order.id, payment.amountPaise, payment.currency || 'INR', payment.order.status || 'created',
      JSON.stringify({ receipt: payment.order.receipt || null })]
  );
  if (result.rowCount === 1) return;

  const existing = await client.query(
    `SELECT company_id, purpose, plan_id, billing_cycle, amount_paise, currency
       FROM subscription_payments WHERE razorpay_order_id = $1 FOR UPDATE`,
    [payment.order.id]
  );
  const row = existing.rows[0];
  if (!row || String(row.company_id) !== String(payment.companyId) || row.purpose !== payment.purpose ||
      Number(row.plan_id) !== Number(payment.planId) || row.billing_cycle !== payment.billingCycle ||
      Number(row.amount_paise) !== Number(payment.amountPaise) || row.currency !== (payment.currency || 'INR')) {
    const error = new Error('Provider order ID is already associated with a different subscription payment.');
    error.code = 'SUBSCRIPTION_PAYMENT_ORDER_CONFLICT';
    throw error;
  }
}

async function recordCapturedSubscriptionPayment(client, payment) {
  const prior = await client.query(
    `SELECT company_id, razorpay_order_id, razorpay_payment_id, status
       FROM subscription_payments
      WHERE razorpay_payment_id = $1 OR razorpay_order_id = $2
      FOR UPDATE`,
    [payment.paymentId, payment.orderId]
  );
  for (const row of prior.rows) {
    if (String(row.company_id) !== String(payment.companyId) || String(row.razorpay_order_id) !== String(payment.orderId) ||
        (row.razorpay_payment_id && String(row.razorpay_payment_id) !== String(payment.paymentId))) {
      const error = new Error('Provider payment or order is already associated with another company or transaction.');
      error.code = 'SUBSCRIPTION_PAYMENT_IDENTITY_CONFLICT';
      throw error;
    }
  }
  await recordSubscriptionPaymentAttempt(client, { ...payment, status: 'captured' });
  const result = await client.query(
    `INSERT INTO subscription_payments
       (company_id, purpose, plan_id, billing_cycle, razorpay_order_id,
        razorpay_payment_id, amount_paise, currency, status, provider_status,
        captured_at, provider_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'captured',$9,NOW(),$10::jsonb)
     ON CONFLICT (razorpay_order_id) DO UPDATE SET
       razorpay_payment_id = EXCLUDED.razorpay_payment_id,
       status = 'captured',
       provider_status = EXCLUDED.provider_status,
       captured_at = COALESCE(subscription_payments.captured_at, EXCLUDED.captured_at),
       provider_payload = EXCLUDED.provider_payload,
       updated_at = NOW()
     WHERE subscription_payments.company_id = EXCLUDED.company_id
       AND subscription_payments.purpose = EXCLUDED.purpose
       AND subscription_payments.plan_id = EXCLUDED.plan_id
       AND subscription_payments.billing_cycle = EXCLUDED.billing_cycle
       AND subscription_payments.amount_paise = EXCLUDED.amount_paise
       AND subscription_payments.currency = EXCLUDED.currency
       AND (subscription_payments.razorpay_payment_id IS NULL OR
            subscription_payments.razorpay_payment_id = EXCLUDED.razorpay_payment_id)
     RETURNING id`,
    [payment.companyId, payment.purpose, payment.planId, payment.billingCycle,
      payment.orderId, payment.paymentId, payment.amountPaise, payment.currency || 'INR',
      payment.providerStatus || 'captured', JSON.stringify(payment.providerPayload || {})]
  );
  if (result.rowCount !== 1) {
    const error = new Error('Provider payment does not match the persisted order and company.');
    error.code = 'SUBSCRIPTION_PAYMENT_ORDER_CONFLICT';
    throw error;
  }
}

async function recordSubscriptionPaymentAttempt(client, payment) {
  const result = await client.query(
    `INSERT INTO subscription_payment_attempts
       (company_id, razorpay_order_id, razorpay_payment_id, status,
        amount_paise, currency, provider_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (razorpay_payment_id) DO UPDATE SET
       status = CASE WHEN subscription_payment_attempts.status = 'captured' THEN 'captured' ELSE EXCLUDED.status END,
       provider_payload = EXCLUDED.provider_payload,
       updated_at = NOW()
     WHERE subscription_payment_attempts.company_id = EXCLUDED.company_id
       AND subscription_payment_attempts.razorpay_order_id = EXCLUDED.razorpay_order_id
       AND subscription_payment_attempts.amount_paise = EXCLUDED.amount_paise
       AND subscription_payment_attempts.currency = EXCLUDED.currency
     RETURNING id`,
    [payment.companyId, payment.orderId, payment.paymentId, payment.status,
      payment.amountPaise, payment.currency || 'INR', JSON.stringify(payment.providerPayload || {})]
  );
  if (result.rowCount !== 1) {
    const error = new Error('Provider payment attempt is already associated with another order or company.');
    error.code = 'SUBSCRIPTION_PAYMENT_IDENTITY_CONFLICT';
    throw error;
  }
  if (payment.status !== 'captured') {
    await client.query(
      `UPDATE subscription_payments SET status = $1, provider_status = $1,
              provider_payload = $2::jsonb, updated_at = NOW()
        WHERE razorpay_order_id = $3 AND company_id = $4 AND status <> 'captured'`,
      [payment.status, JSON.stringify(payment.providerPayload || {}), payment.orderId, payment.companyId]
    );
  }
}

module.exports = { recordPendingSubscriptionPayment, recordCapturedSubscriptionPayment, recordSubscriptionPaymentAttempt };
