/**
 * tests/e2e_finance_verification.test.js
 *
 * End-to-End Acceptance Test for Job-Centric Financial Architecture
 * Runs all 7 acceptance steps programmatically with full AsyncLocalStorage tenant context.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { storage } = require('../middleware/als');
const invoiceService = require('../services/invoiceService');
const pdfInvoiceService = require('../services/pdfInvoiceService');
const autoMigrate = require('../migrations/autoMigrate');

test('🚀 End-to-End Acceptance Test: Job-Centric Financial Architecture', async (t) => {
  let companyId;
  let ownerId;
  let employeeId;
  let customerId;
  let jobId;
  let invoiceId;
  let v2InvoiceId;

  await t.test('Step 0: Apply DB Migrations (015_finance_and_invoicing_system)', async () => {
    await autoMigrate.runNumberedMigrations();
    assert.ok(true, 'Migrations applied cleanly');
  });

  await t.test('Step 1: Setup Test Entities & Execute Full E2E Flow', async () => {
    // 1. Company
    const compSlug = 'TC_' + Math.floor(Math.random() * 89999 + 10000);
    const compRes = await pool.query(
      `INSERT INTO companies (company_name, company_id, status) VALUES ('Test Financial Corp', $1, 'active') RETURNING id`,
      [compSlug]
    );
    companyId = compRes.rows[0].id;

    // 2. Owner
    const ownerEmail = `owner_test_${Date.now()}@prozync.in`;
    const ownerRes = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id) VALUES ('Test Owner', $1, 'hash', 'owner', $2) RETURNING id`,
      [ownerEmail, companyId]
    );
    ownerId = ownerRes.rows[0].id;

    // 3. Employee
    const empEmail = `emp_test_${Date.now()}@prozync.in`;
    const empRes = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id) VALUES ('Test Employee', $1, 'hash', 'employee', $2) RETURNING id`,
      [empEmail, companyId]
    );
    employeeId = empRes.rows[0].id;

    // 4. Customer
    const custEmail = `rahul_${Date.now()}@example.com`;
    const custRes = await pool.query(
      `INSERT INTO customers (name, email, phone, company_id) VALUES ('Rahul Sharma', $1, '9876543210', $2) RETURNING id`,
      [custEmail, companyId]
    );
    customerId = custRes.rows[0].id;

    assert.ok(companyId && ownerId && employeeId && customerId, 'All test entities created');

    // Run remaining steps inside tenant storage context to pass RLS checks
    await storage.run({ isWebRequest: true, companyId, role: 'owner', userId: ownerId }, async () => {
      // Step 1: Customer Portal Request -> Owner Accept
      const jobReq = await pool.query(
        `INSERT INTO jobs (title, description, customer_id, company_id, source, approval_status, status, is_billable)
         VALUES ('Electrical Panel Repair', 'Fix main Circuit breaker', $1, $2, 'customer', 'pending_approval', 'pending', TRUE)
         RETURNING id`,
        [customerId, companyId]
      );
      jobId = jobReq.rows[0].id;

      const approveRes = await pool.query(
        `UPDATE jobs
         SET approval_status = 'approved', approved_at = NOW(), status = 'open', assigned_to = $1
         WHERE id = $2
         RETURNING *`,
        [employeeId, jobId]
      );

      assert.ok(approveRes.rows.length > 0, 'Job approved');
      assert.equal(approveRes.rows[0].approval_status, 'approved');

      // Step 2: Employee Portal -> Accept & 100% Progress
      await pool.query(`UPDATE jobs SET employee_status = 'accepted', accepted_at = NOW(), started_at = NOW() WHERE id = $1`, [jobId]);
      const progRes = await pool.query(
        `UPDATE jobs SET progress = 100, status = 'completed', employee_status = 'completed', completed_at = NOW() WHERE id = $1 RETURNING *`,
        [jobId]
      );
      assert.equal(progRes.rows[0].status, 'completed');

      // Step 3: Editor Data Preparation
      const editorData = await invoiceService.prepareInvoiceDataForJob(jobId, companyId);
      assert.equal(editorData.job.id, jobId);
      assert.equal(editorData.job.customer_name, 'Rahul Sharma');

      // Step 4: Finalize Invoice
      const result = await invoiceService.finalizeInvoice({
        companyId,
        jobId,
        userId: ownerId,
        invoiceData: {
          labour_hours: 5,
          labour_rate: 600,
          equipment_charges: 200,
          transport_charges: 150,
          additional_charges: 0,
          discount_amount: 50,
          gst_rate: 18.0,
          is_inter_state: false,
          due_days: 15,
          customer_name: 'Rahul Sharma',
          customer_email: 'rahul@example.com',
          customer_phone: '9876543210',
          payment_terms: 'Net 15 Days',
          customer_notes: 'Thanks!',
          lineItems: [
            { item_type: 'labour', description: 'Electrical Labour', hsn_code: '998311', quantity: 5, unit_price: 600, total_amount: 3000 },
            { item_type: 'material', description: 'Breaker Switch', hsn_code: '8536', quantity: 2, unit_price: 450, total_amount: 900 },
          ],
        },
      });

      assert.equal(result.success, true);
      invoiceId = result.invoice.id;
      assert.ok(result.invoice.invoice_number.startsWith('INV-'));

      // Step 5: View & Download Activity Tracking
      await invoiceService.logActivity({
        invoiceId,
        companyId,
        actionType: 'viewed',
        performedByType: 'customer',
        performedById: customerId,
        performedByName: 'Rahul Sharma',
      });

      await invoiceService.logActivity({
        invoiceId,
        companyId,
        actionType: 'downloaded',
        performedByType: 'customer',
        performedById: customerId,
        performedByName: 'Rahul Sharma',
      });

      const checkInv = await pool.query(`SELECT viewed_at, downloaded_at FROM invoices WHERE id = $1`, [invoiceId]);
      assert.ok(checkInv.rows[0].viewed_at !== null);

      // Step 6: Customer Dispute & Owner Reissue (v2.0)
      const disputeRes = await invoiceService.submitDispute({
        invoiceId,
        companyId,
        customerId,
        issueCategory: 'Material mismatch',
        description: 'Breaker switch quantity was 1 instead of 2',
      });
      assert.equal(disputeRes.success, true);

      const reissueRes = await invoiceService.reissueInvoice({
        companyId,
        parentInvoiceId: invoiceId,
        disputeId: disputeRes.dispute.id,
        userId: ownerId,
        updateData: {
          labour_hours: 5,
          labour_rate: 600,
          materials_cost: 450,
          lineItems: [
            { item_type: 'labour', description: 'Electrical Labour', hsn_code: '998311', quantity: 5, unit_price: 600 },
            { item_type: 'material', description: 'Breaker Switch', hsn_code: '8536', quantity: 1, unit_price: 450 },
          ],
        },
      });
      assert.equal(reissueRes.invoice.version_number, 2);
      v2InvoiceId = reissueRes.invoice.id;

      // Step 7: Payment Settlement
      const payRes = await invoiceService.recordPayment({
        invoiceId: v2InvoiceId,
        companyId,
        paymentMethod: 'cash',
        transactionReference: 'CASH-9912',
        amount: reissueRes.invoice.total_amount,
        notes: 'Received cash payment',
        recordedBy: ownerId,
      });
      assert.equal(payRes.status, 'paid');

      const jobCheck = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
      assert.equal(jobCheck.rows[0].status, 'billed_and_closed');
    });
  });

  t.after(async () => {
    await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]).catch(() => {});
  });
});
