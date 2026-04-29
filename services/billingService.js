/**
 * services/billingService.js
 *
 * Billing & Invoicing System
 *
 * Hardening (Sections 1, 6, 11):
 *   - Invoice insert wrapped in a DB transaction (Section 1)
 *   - Idempotency: SELECT FOR UPDATE prevents duplicate invoices under concurrent calls (Section 6)
 *   - Does NOT generate invoice for cancelled jobs (Section 6)
 *   - labor_hours = 0 when started_at is NULL (Section 6)
 *   - Full try/catch — never throws, returns null on failure (Section 11)
 */

'use strict';

const { pool } = require('../db');
const auditService = require('./auditService');

/**
 * Generate an invoice for a completed job.
 * @param {string} jobId
 * @param {string} companyId
 * @returns {Promise<object|null>}
 */
async function generateInvoice(jobId, companyId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch job with row lock to prevent concurrent invoice generation
    const jobResult = await client.query(
      `SELECT id, title, status, customer_id, company_id, started_at, completed_at, accepted_at
       FROM jobs
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [jobId, companyId]
    );

    if (jobResult.rows.length === 0) {
      await client.query('ROLLBACK');
      console.warn(`billingService: Job ${jobId} not found`);
      return null;
    }

    const job = jobResult.rows[0];

    // 2. Section 6: Do NOT generate invoice for cancelled jobs
    if (job.status === 'cancelled') {
      await client.query('ROLLBACK');
      console.log(`billingService: Skipping invoice for cancelled job ${jobId}`);
      return null;
    }

    // 3. Section 6: Idempotency check — only one invoice per job
    const existingInvoice = await client.query(
      'SELECT id, invoice_number FROM invoices WHERE job_id = $1 FOR UPDATE',
      [jobId]
    );
    if (existingInvoice.rows.length > 0) {
      await client.query('ROLLBACK');
      console.log(`billingService: Invoice already exists for job ${jobId}`);
      return existingInvoice.rows[0];
    }

    // 4. Section 6: labor_hours = 0 when started_at is NULL
    let laborHours = 0;
    if (job.started_at && job.completed_at) {
      const startMs = new Date(job.started_at).getTime();
      const endMs   = new Date(job.completed_at).getTime();
      laborHours = Math.max(0, (endMs - startMs) / (1000 * 60 * 60));
      laborHours = parseFloat(laborHours.toFixed(2));
    }

    // 5. Get company rates — wrapped in try/catch: company_id may be non-UUID in legacy envs
    let hourlyRate    = 50;
    let serviceCharge = 0;
    try {
      const [hourlyRateRow, serviceChargeRow] = await Promise.all([
        pool.query(
          `SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = 'hourly_rate'`,
          [companyId]
        ),
        pool.query(
          `SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = 'service_charge'`,
          [companyId]
        ),
      ]);
      hourlyRate    = parseFloat(hourlyRateRow.rows[0]?.setting_value)    || 50;
      serviceCharge = parseFloat(serviceChargeRow.rows[0]?.setting_value) || 0;
    } catch (rateErr) {
      // Non-UUID company_id or missing table — use defaults, don't crash
      console.warn(`billingService: company_settings query failed for job ${jobId} (using defaults):`, rateErr.message);
    }
    const laborCost     = parseFloat((laborHours * hourlyRate).toFixed(2));

    // 6. Sum materials cost
    const materialsResult = await client.query(
      `SELECT COALESCE(SUM(total_cost), 0) AS total_materials_cost
       FROM job_materials
       WHERE job_id = $1 AND company_id = $2`,
      [jobId, companyId]
    );
    const materialsCost = parseFloat(materialsResult.rows[0].total_materials_cost) || 0;

    const totalAmount = parseFloat((laborCost + materialsCost + serviceCharge).toFixed(2));

    // 7. Generate unique invoice number
    const invoiceNumber = `INV-${Date.now()}-${jobId.slice(0, 8).toUpperCase()}`;

    // 8. Insert invoice inside transaction
    const invoiceResult = await client.query(
      `INSERT INTO invoices
         (job_id, company_id, customer_id, invoice_number,
          labor_hours, labor_cost, materials_cost, service_charge,
          total_amount, status, breakdown, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, NOW())
       RETURNING *`,
      [
        jobId,
        companyId,
        job.customer_id || null,
        invoiceNumber,
        laborHours,
        laborCost,
        materialsCost,
        serviceCharge,
        totalAmount,
        JSON.stringify({
          labor:          { hours: laborHours, rate: hourlyRate, cost: laborCost },
          materials:      { cost: materialsCost },
          service_charge: serviceCharge,
        }),
      ]
    );

    await client.query('COMMIT');

    const invoice = invoiceResult.rows[0];

    // 9. Audit log (non-blocking, outside transaction)
    auditService.log({
      companyId,
      actorType: 'system',
      actionType: 'invoice_generated',
      entityType: 'invoice',
      entityId: invoice.id,
      newValue: {
        job_id: jobId,
        invoice_number: invoiceNumber,
        total_amount: totalAmount,
        labor_hours: laborHours,
      },
    }).catch(() => {});

    console.log(`💰 Invoice generated: ${invoiceNumber} for job ${jobId} — $${totalAmount}`);
    return invoice;

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`billingService.generateInvoice error for job ${jobId}:`, err.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { generateInvoice };
