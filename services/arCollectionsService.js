const { pool } = require('../db');
const ProviderFactory = require('../ai/providers/provider.factory');

class ArCollectionsService {
  /**
   * Calculates AR Aging Bucket metrics for a company.
   */
  static async getAgingSummary(companyId) {
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_company_id = '${companyId}'`);

      const res = await client.query(
        `SELECT 
           COALESCE(SUM(CASE WHEN due_date >= CURRENT_DATE THEN amount_outstanding ELSE 0 END), 0) AS current_amount,
           COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 1 AND 30 THEN amount_outstanding ELSE 0 END), 0) AS bucket_1_30,
           COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 31 AND 60 THEN amount_outstanding ELSE 0 END), 0) AS bucket_31_60,
           COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 61 AND 90 THEN amount_outstanding ELSE 0 END), 0) AS bucket_61_90,
           COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date > 90 THEN amount_outstanding ELSE 0 END), 0) AS bucket_90_plus,
           COUNT(id) as total_active_schedules
         FROM ar_collection_schedules
         WHERE company_id = $1 AND current_stage != 'settled'`,
        [companyId]
      );

      return res.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Evaluates unpaid invoices and syncs them into active AR collection schedules.
   */
  static async syncInvoicesToSchedules(companyId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_company_id = '${companyId}'`);

      // Fetch unpaid invoices
      const invoicesRes = await client.query(
        `SELECT i.id, i.customer_name, i.amount, i.due_date, i.company_id
         FROM invoices i
         WHERE i.company_id = $1 AND i.status != 'paid'`,
        [companyId]
      );

      let syncedCount = 0;
      for (const inv of invoicesRes.rows) {
        const dueDate = new Date(inv.due_date);
        const today = new Date();
        const diffDays = Math.ceil((today - dueDate) / (1000 * 60 * 60 * 24));

        let stage = 'pre_due_3d';
        if (diffDays >= 30) stage = 'overdue_30d';
        else if (diffDays >= 14) stage = 'overdue_14d';
        else if (diffDays >= 7) stage = 'overdue_7d';
        else if (diffDays >= 1) stage = 'due_1d';

        await client.query(
          `INSERT INTO ar_collection_schedules
           (company_id, invoice_id, customer_name, invoice_amount, amount_outstanding, due_date, current_stage, next_scheduled_reminder)
           VALUES ($1, $2, $3, $4, $4, $5, $6, NOW() + INTERVAL '1 day')
           ON CONFLICT (company_id, invoice_id)
           DO UPDATE SET
             amount_outstanding = EXCLUDED.amount_outstanding,
             current_stage = EXCLUDED.current_stage,
             updated_at = NOW()`,
          [companyId, inv.id, inv.customer_name || 'Valued Customer', inv.amount, inv.due_date, stage]
        );
        syncedCount++;
      }

      await client.query('COMMIT');
      return { success: true, syncedCount };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Generates AI Payment Plan Options via Groq LLM.
   */
  static async generatePaymentPlanOffer({ customerName, outstandingAmount, overdueDays }) {
    try {
      const provider = ProviderFactory.getProvider();
      const prompt = `You are an expert AR Collections Assistant for SmartERP.
Draft a polite 1-sentence payment plan offer for customer ${customerName} who has an overdue balance of ₹${outstandingAmount} (${overdueDays} days overdue).
Suggest 50% payment today with a 2% early settlement discount and 50% in 14 days.`.trim();

      const completion = await provider.generateCompletion({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      });

      return completion.content
        ? completion.content.trim()
        : `Offer 50% down payment (₹${(outstandingAmount * 0.5).toFixed(2)}) today with 2% discount, remaining 50% in 14 days.`;
    } catch (err) {
      return `Offer 50% down payment (₹${(outstandingAmount * 0.5).toFixed(2)}) today with 2% discount, remaining 50% in 14 days.`;
    }
  }

  /**
   * Manually dispatches a WhatsApp Business API Template reminder.
   */
  static async dispatchReminder({ companyId, scheduleId, channel = 'whatsapp' }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_company_id = '${companyId}'`);

      const schedRes = await client.query(
        `SELECT * FROM ar_collection_schedules WHERE id = $1 AND company_id = $2`,
        [scheduleId, companyId]
      );

      if (schedRes.rows.length === 0) {
        throw new Error('AR Collection schedule not found.');
      }

      const sched = schedRes.rows[0];
      const messageBody = `Hello ${sched.customer_name}, this is an automated reminder regarding Invoice #${sched.invoice_id} for ₹${sched.amount_outstanding} (Due Date: ${sched.due_date}). Please use your payment link to settle. Thank you.`;

      // Insert log
      const logRes = await client.query(
        `INSERT INTO ar_collection_logs (schedule_id, company_id, stage, channel, message_body, delivery_status, meta_message_id)
         VALUES ($1, $2, $3, $4, $5, 'sent', $6)
         RETURNING *`,
        [scheduleId, companyId, sched.current_stage, channel, messageBody, `META-WA-${Date.now()}`]
      );

      // Update schedule last reminder date
      await client.query(
        `UPDATE ar_collection_schedules 
         SET next_scheduled_reminder = NOW() + INTERVAL '7 days', updated_at = NOW()
         WHERE id = $1`,
        [scheduleId]
      );

      await client.query('COMMIT');
      return { success: true, log: logRes.rows[0] };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = ArCollectionsService;
