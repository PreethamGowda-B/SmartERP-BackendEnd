/**
 * services/invoiceService.js
 *
 * Domain Service for Job-Centric Financial & Invoicing System
 * Handles Draft Preparation, Invoice Finalization, Versioning,
 * Dispute Management, View/Download Tracking, and Payment Settlement.
 */

'use strict';

const { pool } = require('../db');
const auditService = require('./auditService');
const pdfInvoiceService = require('./pdfInvoiceService');

class InvoiceService {
  /**
   * Fetches pre-populated data for the Dedicated Invoice Editor Page.
   * Pulls job details, labor hours, material requests, customer info, and company rates.
   */
  static async prepareInvoiceDataForJob(jobId, companyId) {
    const jobRes = await pool.query(
      `SELECT j.*, 
              c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
       FROM jobs j
       LEFT JOIN customers c ON j.customer_id::text = c.id::text
       WHERE j.id = $1 AND j.company_id = $2`,
      [jobId, companyId]
    );

    if (jobRes.rows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job = jobRes.rows[0];

    // Calculate labor hours
    let laborHours = 0;
    if (job.started_at && job.completed_at) {
      const startMs = new Date(job.started_at).getTime();
      const endMs = new Date(job.completed_at).getTime();
      laborHours = Math.max(0.5, parseFloat(((endMs - startMs) / (1000 * 60 * 60)).toFixed(2)));
    } else {
      laborHours = 8.0; // Default estimate if untracked
    }

    // Get hourly rate from company_settings or default
    let hourlyRate = parseFloat(job.hourly_rate) || 500.0;
    try {
      const rateRes = await pool.query(
        `SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = 'hourly_rate'`,
        [companyId]
      );
      if (rateRes.rows.length > 0) {
        hourlyRate = parseFloat(rateRes.rows[0].setting_value) || hourlyRate;
      }
    } catch (_) {}

    // Pull materials used from material_requests approved for this company/job
    const materialsRes = await pool.query(
      `SELECT item_name, quantity, description 
       FROM material_requests 
       WHERE company_id = $1 AND status = 'approved'
       ORDER BY created_at DESC`,
      [companyId]
    );

    const materialsUsed = materialsRes.rows.map((m) => ({
      item_name: m.item_name,
      quantity: parseFloat(m.quantity || 1),
      unit_cost: 150.0, // Default estimate
      total_cost: parseFloat((m.quantity || 1) * 150.0),
    }));

    return {
      job: {
        id: job.id,
        title: job.title,
        description: job.description,
        status: job.status,
        started_at: job.started_at,
        completed_at: job.completed_at,
        customer_id: job.customer_id,
        customer_name: job.customer_name || 'Direct Customer',
        customer_email: job.customer_email || '',
        customer_phone: job.customer_phone || '',
        is_billable: job.is_billable,
      },
      prefilled: {
        labour_hours: laborHours,
        labour_rate: hourlyRate,
        materials_used: materialsUsed,
        equipment_charges: 0,
        transport_charges: 0,
        additional_charges: 0,
        discount_amount: 0,
        gst_rate: 18.0,
        is_inter_state: false,
        due_days: 15,
      },
    };
  }

  /**
   * Finalizes an invoice in an atomic transaction.
   * Generates Invoice #, PDF, inserts DB records, creates AR schedule & GST ledger.
   */
  static async finalizeInvoice({ companyId, jobId, userId, invoiceData }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Fetch job with lock
      const jobRes = await client.query(
        `SELECT j.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
         FROM jobs j
         LEFT JOIN customers c ON j.customer_id::text = c.id::text
         WHERE j.id = $1 AND j.company_id::text = $2::text
         FOR UPDATE OF j`,
        [jobId, companyId]
      );

      if (jobRes.rows.length === 0) {
        throw new Error(`Job ${jobId} not found`);
      }

      const job = jobRes.rows[0];

      // 2. Check if invoice is already issued/paid for this job
      const existingIssuedInv = await client.query(
        `SELECT id, invoice_number FROM invoices WHERE job_id = $1 AND company_id::text = $2::text AND is_latest = TRUE AND status IN ('issued', 'paid')`,
        [jobId, companyId]
      );

      if (existingIssuedInv.rows.length > 0) {
        await client.query('COMMIT');
        return { success: true, invoice: existingIssuedInv.rows[0], reason: 'invoice_already_exists' };
      }

      // Archive any legacy/draft invoices for this job so the new issued invoice becomes active
      await client.query(
        `UPDATE invoices SET is_latest = FALSE, updated_at = NOW() WHERE job_id = $1 AND company_id::text = $2::text`,
        [jobId, companyId]
      );

      // 3. Compute Financial Totals
      const labourHours = parseFloat(invoiceData.labour_hours || 0);
      const labourRate = parseFloat(invoiceData.labour_rate || 0);
      const labourCost = parseFloat((labourHours * labourRate).toFixed(2));

      let materialsCost = 0;
      const lineItems = invoiceData.lineItems || [];
      lineItems.forEach((item) => {
        item.total_amount = parseFloat((parseFloat(item.quantity || 1) * parseFloat(item.unit_price || 0)).toFixed(2));
        if (item.item_type === 'material') {
          materialsCost += item.total_amount;
        }
      });

      const equipmentCharges = parseFloat(invoiceData.equipment_charges || 0);
      const transportCharges = parseFloat(invoiceData.transport_charges || 0);
      const additionalCharges = parseFloat(invoiceData.additional_charges || 0);
      const discountAmount = parseFloat(invoiceData.discount_amount || 0);

      const subtotal = Math.max(
        0,
        parseFloat(
          (labourCost + materialsCost + equipmentCharges + transportCharges + additionalCharges - discountAmount).toFixed(2)
        )
      );

      const gstRate = parseFloat(invoiceData.gst_rate || 18.0) / 100.0;
      const totalTax = parseFloat((subtotal * gstRate).toFixed(2));

      let cgst = 0;
      let sgst = 0;
      let igst = 0;

      if (invoiceData.is_inter_state) {
        igst = totalTax;
      } else {
        cgst = parseFloat((totalTax / 2).toFixed(2));
        sgst = parseFloat((totalTax / 2).toFixed(2));
      }

      const totalAmount = parseFloat((subtotal + totalTax).toFixed(2));
      const dueDays = parseInt(invoiceData.due_days || 15, 10);
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + dueDays);

      // Generate Invoice Number
      const year = new Date().getFullYear();
      const invoiceNumRes = await client.query(
        `SELECT COUNT(*) AS count FROM invoices WHERE company_id = $1`,
        [companyId]
      );
      const count = parseInt(invoiceNumRes.rows[0].count, 10) + 1;
      const invoiceNumber = `INV-${year}-${String(count).padStart(4, '0')}`;

      // 4. Insert Invoice Row
      const invRes = await client.query(
        `INSERT INTO invoices
         (company_id, job_id, customer_id, customer_name, customer_email, customer_phone,
          invoice_number, version_number, is_latest, status,
          labour_hours, labour_rate, labour_cost, materials_cost, equipment_charges,
          transport_charges, additional_charges, discount_amount, subtotal,
          is_inter_state, gst_rate, cgst, sgst, igst, total_tax,
          total_amount, amount_paid, amount_due, due_date, payment_terms,
          customer_notes, internal_notes, created_at, updated_at)
         VALUES
         ($1, $2, $3, $4, $5, $6, $7, 1, TRUE, 'issued',
          $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22,
          $23, 0.00, $23, $24, $25, $26, $27, NOW(), NOW())
         RETURNING *`,
        [
          companyId,
          jobId,
          job.customer_id || null,
          invoiceData.customer_name || job.customer_name || 'Customer',
          invoiceData.customer_email || job.customer_email || '',
          invoiceData.customer_phone || job.customer_phone || '',
          invoiceNumber,
          labourHours,
          labourRate,
          labourCost,
          materialsCost,
          equipmentCharges,
          transportCharges,
          additionalCharges,
          discountAmount,
          subtotal,
          Boolean(invoiceData.is_inter_state),
          invoiceData.gst_rate || 18.0,
          cgst,
          sgst,
          igst,
          totalTax,
          totalAmount,
          dueDate,
          invoiceData.payment_terms || 'Due on receipt',
          invoiceData.customer_notes || 'Thank you for your business!',
          invoiceData.internal_notes || '',
        ]
      );

      const invoice = invRes.rows[0];

      // 5. Insert Line Items
      if (lineItems.length > 0) {
        for (const item of lineItems) {
          await client.query(
            `INSERT INTO invoice_items
             (invoice_id, company_id, item_type, description, hsn_code, quantity, unit_price, total_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              invoice.id,
              companyId,
              item.item_type || 'service',
              item.description || 'Service Line Item',
              item.hsn_code || '998311',
              item.quantity || 1,
              item.unit_price || 0,
              item.total_amount || 0,
            ]
          );
        }
      } else {
        // Fallback default labour item
        await client.query(
          `INSERT INTO invoice_items
           (invoice_id, company_id, item_type, description, hsn_code, quantity, unit_price, total_amount)
           VALUES ($1, $2, 'labour', 'Labour Charges', '998311', $3, $4, $5)`,
          [invoice.id, companyId, labourHours, labourRate, labourCost]
        );
      }

      // 6. Generate PDF and save URL
      const pdfBuffer = await pdfInvoiceService.generateInvoicePDF(invoice, lineItems);
      // In production, save buffer to Cloudinary or S3. Fallback: Data URL or route URL
      const pdfUrl = `/api/invoices/${invoice.id}/pdf`;
      await client.query(`UPDATE invoices SET pdf_url = $1 WHERE id = $2`, [pdfUrl, invoice.id]);
      invoice.pdf_url = pdfUrl;

      // 7. Create Accounts Receivable Schedule Entry
      await client.query(
        `INSERT INTO ar_collection_schedules
         (company_id, invoice_id, customer_id, customer_name, customer_phone, customer_email,
          invoice_amount, amount_outstanding, due_date, current_stage, is_paused)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'pre_due_3d', FALSE)
         ON CONFLICT (company_id, invoice_id) DO UPDATE
         SET invoice_amount = EXCLUDED.invoice_amount, amount_outstanding = EXCLUDED.amount_outstanding`,
        [
          companyId,
          invoice.id,
          job.customer_id || null,
          invoice.customer_name,
          invoice.customer_phone,
          invoice.customer_email,
          totalAmount,
          dueDate,
        ]
      );

      await client.query('COMMIT');

      // Non-blocking audit log
      auditService.log({
        companyId,
        actorType: 'user',
        actorId: userId,
        actionType: 'invoice_finalized',
        entityType: 'invoice',
        entityId: invoice.id,
        newValue: { invoice_number: invoiceNumber, total_amount: totalAmount },
      }).catch(() => {});

      return { success: true, invoice };

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`invoiceService.finalizeInvoice error:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reissues an invoice in response to a customer dispute (publishes Version N+1).
   */
  static async reissueInvoice({ companyId, parentInvoiceId, disputeId, userId, updateData }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Fetch parent invoice
      const parentRes = await client.query(
        `SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [parentInvoiceId, companyId]
      );

      if (parentRes.rows.length === 0) {
        throw new Error(`Parent invoice ${parentInvoiceId} not found`);
      }

      const parent = parentRes.rows[0];
      const newVersionNumber = parent.version_number + 1;

      // Mark parent as is_latest = FALSE
      await client.query(`UPDATE invoices SET is_latest = FALSE WHERE id = $1`, [parentInvoiceId]);

      // Calculate totals for new version
      const labourHours = parseFloat(updateData.labour_hours || parent.labour_hours);
      const labourRate = parseFloat(updateData.labour_rate || parent.labour_rate);
      const labourCost = parseFloat((labourHours * labourRate).toFixed(2));
      const materialsCost = parseFloat(updateData.materials_cost || parent.materials_cost);
      const equipmentCharges = parseFloat(updateData.equipment_charges || parent.equipment_charges);
      const transportCharges = parseFloat(updateData.transport_charges || parent.transport_charges);
      const additionalCharges = parseFloat(updateData.additional_charges || parent.additional_charges);
      const discountAmount = parseFloat(updateData.discount_amount || parent.discount_amount);

      const subtotal = Math.max(
        0,
        parseFloat(
          (labourCost + materialsCost + equipmentCharges + transportCharges + additionalCharges - discountAmount).toFixed(2)
        )
      );

      const gstRate = parseFloat(updateData.gst_rate || parent.gst_rate || 18.0) / 100.0;
      const totalTax = parseFloat((subtotal * gstRate).toFixed(2));

      let cgst = 0;
      let sgst = 0;
      let igst = 0;
      const isInterState = updateData.is_inter_state !== undefined ? updateData.is_inter_state : parent.is_inter_state;

      if (isInterState) {
        igst = totalTax;
      } else {
        cgst = parseFloat((totalTax / 2).toFixed(2));
        sgst = parseFloat((totalTax / 2).toFixed(2));
      }

      const totalAmount = parseFloat((subtotal + totalTax).toFixed(2));

      // Insert New Invoice Version
      const newInvRes = await client.query(
        `INSERT INTO invoices
         (company_id, job_id, customer_id, customer_name, customer_email, customer_phone,
          invoice_number, version_number, parent_invoice_id, is_latest, status,
          labour_hours, labour_rate, labour_cost, materials_cost, equipment_charges,
          transport_charges, additional_charges, discount_amount, subtotal,
          is_inter_state, gst_rate, cgst, sgst, igst, total_tax,
          total_amount, amount_paid, amount_due, due_date, payment_terms,
          customer_notes, internal_notes, created_at, updated_at)
         VALUES
         ($1, $2, $3, $4, $5, $6,
          $7, $8, $9, TRUE, 'issued',
          $10, $11, $12, $13, $14,
          $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24,
          $25, $26, $25, $27, $28,
          $29, $30, NOW(), NOW())
         RETURNING *`,
        [
          companyId,
          parent.job_id,
          parent.customer_id,
          parent.customer_name,
          parent.customer_email,
          parent.customer_phone,
          parent.invoice_number,
          newVersionNumber,
          parent.id,
          labourHours,
          labourRate,
          labourCost,
          materialsCost,
          equipmentCharges,
          transportCharges,
          additionalCharges,
          discountAmount,
          subtotal,
          isInterState,
          gstRate * 100,
          cgst,
          sgst,
          igst,
          totalTax,
          totalAmount,
          parent.amount_paid,
          parent.due_date,
          parent.payment_terms,
          updateData.customer_notes || parent.customer_notes,
          `Reissued v${newVersionNumber} following dispute resolution`,
        ]
      );

      const newInvoice = newInvRes.rows[0];

      // Insert updated line items
      const lineItems = updateData.lineItems || [];
      for (const item of lineItems) {
        await client.query(
          `INSERT INTO invoice_items
           (invoice_id, company_id, item_type, description, hsn_code, quantity, unit_price, total_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            newInvoice.id,
            companyId,
            item.item_type || 'service',
            item.description || 'Service Line Item',
            item.hsn_code || '998311',
            item.quantity || 1,
            item.unit_price || 0,
            (item.quantity || 1) * (item.unit_price || 0),
          ]
        );
      }

      // Mark dispute as resolved
      if (disputeId) {
        await client.query(
          `UPDATE invoice_disputes 
           SET status = 'resolved', resolved_in_version = $1, updated_at = NOW() 
           WHERE id = $2 AND company_id = $3`,
          [newVersionNumber, disputeId, companyId]
        );
      }

      // Resume AR schedule with updated amount
      await client.query(
        `UPDATE ar_collection_schedules
         SET invoice_id = $1, invoice_amount = $2, amount_outstanding = $2, is_paused = FALSE, updated_at = NOW()
         WHERE company_id = $3 AND invoice_id = $4`,
        [newInvoice.id, totalAmount, companyId, parentInvoiceId]
      );

      await client.query('COMMIT');

      return { success: true, invoice: newInvoice };

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`invoiceService.reissueInvoice error:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Tracks customer view and download activity with timestamps.
   */
  static async logActivity({ invoiceId, companyId, actionType, performedByType, performedById, performedByName, ipAddress, userAgent }) {
    try {
      await pool.query(
        `INSERT INTO invoice_activity_logs
         (invoice_id, company_id, action_type, performed_by_type, performed_by_id, performed_by_name, ip_address, user_agent, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [invoiceId, companyId, actionType, performedByType, performedById || null, performedByName || 'Customer', ipAddress || '', userAgent || '']
      );

      if (actionType === 'viewed') {
        await pool.query(
          `UPDATE invoices SET viewed_at = NOW(), status = CASE WHEN status = 'issued' THEN 'viewed' ELSE status END WHERE id = $1 AND company_id = $2`,
          [invoiceId, companyId]
        );
      } else if (actionType === 'downloaded') {
        await pool.query(
          `UPDATE invoices SET downloaded_at = NOW() WHERE id = $1 AND company_id = $2`,
          [invoiceId, companyId]
        );
      }
    } catch (err) {
      console.error('invoiceService.logActivity error:', err.message);
    }
  }

  /**
   * Records a payment against an invoice and updates AR/Job status.
   */
  static async recordPayment({ invoiceId, companyId, paymentMethod, transactionReference, amount, notes, recordedBy }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const invRes = await client.query(
        `SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [invoiceId, companyId]
      );

      if (invRes.rows.length === 0) {
        throw new Error(`Invoice ${invoiceId} not found`);
      }

      const invoice = invRes.rows[0];
      const newAmountPaid = parseFloat((parseFloat(invoice.amount_paid || 0) + parseFloat(amount)).toFixed(2));
      const newAmountDue = Math.max(0, parseFloat((parseFloat(invoice.total_amount) - newAmountPaid).toFixed(2)));
      const newStatus = newAmountDue === 0 ? 'paid' : 'partially_paid';

      // Insert payment record
      await client.query(
        `INSERT INTO invoice_payments
         (invoice_id, company_id, payment_method, transaction_reference, amount, notes, recorded_by, payment_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [invoiceId, companyId, paymentMethod, transactionReference || '', amount, notes || '', recordedBy || null]
      );

      // Update invoice status
      await client.query(
        `UPDATE invoices
         SET amount_paid = $1, amount_due = $2, status = $3, updated_at = NOW()
         WHERE id = $4 AND company_id = $5`,
        [newAmountPaid, newAmountDue, newStatus, invoiceId, companyId]
      );

      // Settle AR schedule if fully paid
      if (newStatus === 'paid') {
        await client.query(
          `UPDATE ar_collection_schedules
           SET amount_outstanding = 0, current_stage = 'settled', is_paused = TRUE, updated_at = NOW()
           WHERE invoice_id = $1 AND company_id = $2`,
          [invoiceId, companyId]
        );

        // Update Job to billed_and_closed
        await client.query(
          `UPDATE jobs SET status = 'billed_and_closed' WHERE id = $1 AND company_id::text = $2::text`,
          [invoice.job_id, companyId]
        );
      }

      await client.query('COMMIT');

      return { success: true, status: newStatus, amountPaid: newAmountPaid, amountDue: newAmountDue };

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`invoiceService.recordPayment error:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Submits a customer dispute/issue report.
   */
  static async submitDispute({ invoiceId, companyId, customerId, issueCategory, description }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const disputeRes = await client.query(
        `INSERT INTO invoice_disputes
         (invoice_id, company_id, customer_id, issue_category, description, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'open', NOW())
         RETURNING *`,
        [invoiceId, companyId, customerId, issueCategory, description]
      );

      // Update invoice status to disputed
      await client.query(
        `UPDATE invoices SET status = 'disputed', updated_at = NOW() WHERE id = $1 AND company_id = $2`,
        [invoiceId, companyId]
      );

      // Pause AR reminder schedule
      await client.query(
        `UPDATE ar_collection_schedules SET is_paused = TRUE, updated_at = NOW() WHERE invoice_id = $1 AND company_id = $2`,
        [invoiceId, companyId]
      );

      await client.query('COMMIT');

      return { success: true, dispute: disputeRes.rows[0] };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('invoiceService.submitDispute error:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = InvoiceService;
