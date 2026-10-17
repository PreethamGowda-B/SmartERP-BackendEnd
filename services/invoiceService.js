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
const { calculateInvoice } = require('./invoiceMath');

async function allocateInvoiceNumber(client, companyId) {
  // Lock one tenant row so every invoice path serializes number allocation company-wide.
  const company = await client.query('SELECT id FROM companies WHERE id::text = $1::text FOR UPDATE', [String(companyId)]);
  if (!company.rows.length) throw new Error('Company not found');
  const year = new Date().getFullYear();
  const numbers = await client.query(
    `SELECT invoice_number FROM invoices WHERE company_id::text = $1::text`,
    [String(companyId)]
  );
  const prefix = `INV-${year}-`;
  const maxSequence = numbers.rows.reduce((max, row) => {
    const match = String(row.invoice_number || '').match(new RegExp(`^INV-${year}-(\\d+)$`));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}${String(maxSequence + 1).padStart(4, '0')}`;
}

class InvoiceService {
  static async createJobDraft({ companyId, jobId, userId }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const jobRes = await client.query(
        `SELECT j.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
         FROM jobs j LEFT JOIN customers c ON j.customer_id::text = c.id::text
         WHERE j.id::text = $1::text AND j.company_id::text = $2::text FOR UPDATE OF j`,
        [String(jobId), String(companyId)]
      );
      if (!jobRes.rows.length) throw new Error('Job not found for this company');
      const job = jobRes.rows[0];
      const existing = await client.query(
        `SELECT * FROM invoices WHERE job_id::text = $1::text AND company_id::text = $2::text
         AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [String(jobId), String(companyId)]
      );
      if (existing.rows.length) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
      const invoiceNumber = await allocateInvoiceNumber(client, companyId);
      const inserted = await client.query(
        `INSERT INTO invoices (company_id, job_id, customer_id, customer_name, customer_email,
          customer_phone, invoice_number, status, amount_paid, amount_due, total_amount,
          created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', 0, 0, 0, NOW(), NOW()) RETURNING *`,
        [companyId, job.id, job.customer_id || null, job.customer_name || 'Customer',
          job.customer_email || '', job.customer_phone || '', invoiceNumber]
      );
      await client.query('COMMIT');
      auditService.log({ companyId, actorType: userId ? 'user' : 'system', actorId: userId || null,
        actionType: 'invoice_draft_created', entityType: 'invoice', entityId: inserted.rows[0].id,
        newValue: { job_id: job.id, invoice_number: invoiceNumber } }).catch(() => {});
      return inserted.rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Fetches pre-populated data for the Dedicated Invoice Editor Page.
   * Pulls job details, labor hours, material requests, customer info, and company rates.
   */
  static async prepareInvoiceDataForJob(identifier, companyId) {
    if (!identifier) {
      const err = new Error('Job or Invoice identifier is required');
      err.statusCode = 400;
      throw err;
    }

    let jobRes = await pool.query(
      `SELECT j.*, 
              c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
       FROM jobs j
       LEFT JOIN customers c ON j.customer_id::text = c.id::text
       WHERE j.id::text = $1::text AND j.company_id::text = $2::text`,
      [String(identifier), String(companyId)]
    );

    // If not found by job ID, check if identifier is actually an invoice ID
    if (jobRes.rows.length === 0) {
      const invCheck = await pool.query(
        `SELECT id, job_id FROM invoices WHERE id::text = $1::text AND company_id::text = $2::text`,
        [String(identifier), String(companyId)]
      );
      if (invCheck.rows.length > 0 && invCheck.rows[0].job_id) {
        jobRes = await pool.query(
          `SELECT j.*, 
                  c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
           FROM jobs j
           LEFT JOIN customers c ON j.customer_id::text = c.id::text
           WHERE j.id::text = $1::text AND j.company_id::text = $2::text`,
          [String(invCheck.rows[0].job_id), String(companyId)]
        );
      } else if (invCheck.rows.length > 0 && !invCheck.rows[0].job_id) {
        // Direct / Walk-in invoice without a linked job
        const invRowRes = await pool.query(
          `SELECT * FROM invoices WHERE id::text = $1::text AND company_id::text = $2::text`,
          [String(identifier), String(companyId)]
        );
        const invRow = invRowRes.rows[0];
        const itemsRes = await pool.query(
          `SELECT item_type, description, hsn_code, quantity, unit_price, total_amount 
           FROM invoice_items WHERE invoice_id::text = $1::text ORDER BY id ASC`,
          [String(invRow.id)]
        );

        return {
          job: {
            id: invRow.id,
            title: `Direct Invoice (${invRow.invoice_number})`,
            description: invRow.customer_notes || 'Walk-in / Direct Sale',
            status: 'completed',
            started_at: invRow.created_at,
            completed_at: invRow.created_at,
            customer_id: invRow.customer_id,
            customer_name: invRow.customer_name || 'Walk-in Customer',
            customer_email: invRow.customer_email || '',
            customer_phone: invRow.customer_phone || '',
            is_billable: true,
          },
          existingInvoice: invRow,
          prefilled: {
            labour_hours: parseFloat(invRow.labour_hours || 0),
            labour_rate: parseFloat(invRow.labour_rate || 0),
            materials_used: [],
            line_items: itemsRes.rows,
            equipment_charges: parseFloat(invRow.equipment_charges || 0),
            transport_charges: parseFloat(invRow.transport_charges || 0),
            additional_charges: parseFloat(invRow.additional_charges || 0),
            discount_amount: parseFloat(invRow.discount_amount || 0),
            gst_rate: parseFloat(invRow.gst_rate || 18.0),
            is_inter_state: Boolean(invRow.is_inter_state),
            payment_terms: invRow.payment_terms || 'Due on receipt',
            customer_notes: invRow.customer_notes || 'Thank you for your business!',
            internal_notes: invRow.internal_notes || '',
            due_days: 15,
          },
        };
      }
    }

    if (jobRes.rows.length === 0) {
      const err = new Error(`Job or Invoice ${identifier} not found`);
      err.statusCode = 404;
      throw err;
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
        `SELECT setting_value FROM company_settings WHERE company_id::text = $1::text AND setting_key = 'hourly_rate'`,
        [String(companyId)]
      );
      if (rateRes.rows.length > 0) {
        hourlyRate = parseFloat(rateRes.rows[0].setting_value) || hourlyRate;
      }
    } catch (_) {}

    // Pull materials used from material_requests approved for this company/job
    let materialsUsed = [];
    try {
      const materialsRes = await pool.query(
        `SELECT item_name, quantity, description 
         FROM material_requests 
         WHERE company_id::text = $1::text AND job_id::text = $2::text AND status = 'approved'
         ORDER BY created_at DESC`,
        [String(companyId), String(job.id)]
      );

      materialsUsed = materialsRes.rows.map((m) => ({
        item_name: m.item_name,
        quantity: parseFloat(m.quantity || 1),
        unit_cost: 0,
        total_cost: 0,
      }));
    } catch (mErr) {
      console.warn('[invoiceService] material_requests query non-fatal warning:', mErr.message);
    }

    // Check if an existing invoice already exists for this job or was queried via invoice ID
    let existingInvoice = null;
    let existingLineItems = [];
    try {
      const invQuery = await pool.query(
        `SELECT * FROM invoices 
         WHERE (job_id::text = $1::text OR id::text = $2::text) AND company_id::text = $3::text 
         ORDER BY CASE WHEN status = 'draft' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
        [String(job.id), String(identifier), String(companyId)]
      );
      if (invQuery.rows.length > 0) {
        existingInvoice = invQuery.rows[0];
        const itemsRes = await pool.query(
          `SELECT item_type, description, hsn_code, quantity, unit_price, total_amount 
           FROM invoice_items WHERE invoice_id::text = $1::text ORDER BY id ASC`,
          [String(existingInvoice.id)]
        );
        existingLineItems = itemsRes.rows;
      }
    } catch (e) {
      console.warn('[invoiceService] existing invoice fetch non-fatal warning:', e.message);
    }

    if (existingInvoice) {
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
        existingInvoice,
        prefilled: {
          labour_hours: parseFloat(existingInvoice.labour_hours || laborHours),
          labour_rate: parseFloat(existingInvoice.labour_rate || hourlyRate),
          materials_used: materialsUsed,
          line_items: existingLineItems,
          equipment_charges: parseFloat(existingInvoice.equipment_charges || 0),
          transport_charges: parseFloat(existingInvoice.transport_charges || 0),
          additional_charges: parseFloat(existingInvoice.additional_charges || 0),
          discount_amount: parseFloat(existingInvoice.discount_amount || 0),
          gst_rate: parseFloat(existingInvoice.gst_rate || 18.0),
          is_inter_state: Boolean(existingInvoice.is_inter_state),
          payment_terms: existingInvoice.payment_terms || 'Net 15 Days',
          customer_notes: existingInvoice.customer_notes || 'Thank you for your business!',
          internal_notes: existingInvoice.internal_notes || '',
          due_days: 15,
        },
      };
    }

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
      const idempotencyKey = invoiceData.idempotency_key;
      if (!idempotencyKey) {
        const err = new Error('Invoice finalization requires an idempotency key');
        err.statusCode = 400;
        throw err;
      }
      const replay = await client.query(
        `SELECT * FROM invoices WHERE company_id::text = $1::text AND idempotency_key = $2 FOR UPDATE`,
        [String(companyId), String(idempotencyKey)]
      );
      if (replay.rows.length) {
        await client.query('COMMIT');
        return { success: true, invoice: replay.rows[0], reason: 'idempotent_replay' };
      }

      // 1. Fetch job with lock (supporting jobId or invoiceId identifier)
      let jobRes = await client.query(
        `SELECT j.*, 
                c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
         FROM jobs j
         LEFT JOIN customers c ON j.customer_id::text = c.id::text
         WHERE j.id::text = $1::text AND j.company_id::text = $2::text
         FOR UPDATE OF j`,
        [String(jobId), String(companyId)]
      );

      if (jobRes.rows.length === 0) {
        // Check if jobId is actually an invoice ID
        const invCheck = await client.query(
          `SELECT id, job_id FROM invoices WHERE id::text = $1::text AND company_id::text = $2::text`,
          [String(jobId), String(companyId)]
        );
        if (invCheck.rows.length > 0 && invCheck.rows[0].job_id) {
          jobRes = await client.query(
            `SELECT j.*, 
                    c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
             FROM jobs j
             LEFT JOIN customers c ON j.customer_id::text = c.id::text
             WHERE j.id::text = $1::text AND j.company_id::text = $2::text
             FOR UPDATE OF j`,
            [String(invCheck.rows[0].job_id), String(companyId)]
          );
        } else if (invCheck.rows.length > 0 && !invCheck.rows[0].job_id) {
          const directInvRes = await client.query(
            `SELECT * FROM invoices WHERE id::text = $1::text AND company_id::text = $2::text FOR UPDATE`,
            [String(jobId), String(companyId)]
          );
          if (directInvRes.rows.length > 0) {
            const directInv = directInvRes.rows[0];
            jobRes = {
              rows: [{
                id: null,
                direct_invoice_id: directInv.id,
                title: `Direct Invoice (${directInv.invoice_number})`,
                customer_id: directInv.customer_id,
                customer_name: directInv.customer_name,
                customer_email: directInv.customer_email,
                customer_phone: directInv.customer_phone,
                is_direct_invoice: true,
              }]
            };
          }
        }
      }

      if (jobRes.rows.length === 0) {
        throw new Error(`Job ${jobId} not found`);
      }

      const job = jobRes.rows[0];
      const actualJobId = job.id || null;
      if (!job.is_direct_invoice && !['completed', 'billed_and_closed'].includes(String(job.status || '').toLowerCase())) {
        const conflict = new Error('Invoices can only be issued for completed jobs');
        conflict.statusCode = 409;
        throw conflict;
      }

      // 2. Check if invoice is already issued/paid/draft for this job — if so, update & increment edited_count
      const existingIssuedInv = await client.query(
        `SELECT id, invoice_number, edited_count, status, amount_paid, version_number, idempotency_key FROM invoices
         WHERE ((job_id IS NOT NULL AND job_id::text = $1::text) OR id::text = $2::text) AND company_id::text = $3::text 
         ORDER BY CASE WHEN status = 'draft' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
        [actualJobId ? String(actualJobId) : '', String(jobId), String(companyId)]
      );

      if (existingIssuedInv.rows.length > 0) {
        const existingId = existingIssuedInv.rows[0].id;
        if (existingIssuedInv.rows[0].idempotency_key === idempotencyKey) {
          const issued = await client.query('SELECT * FROM invoices WHERE id = $1 AND company_id::text = $2::text', [existingId, String(companyId)]);
          await client.query('COMMIT');
          return { success: true, invoice: issued.rows[0], reason: 'idempotent_replay' };
        }
        if (existingIssuedInv.rows[0].status !== 'draft') {
          const conflict = new Error('This invoice has already been issued. Issued or paid invoices are immutable; create a revised version through invoice dispute review.');
          conflict.statusCode = 409;
          throw conflict;
        }

        // Compute Financial Totals for edit
        const labourHours = Number(invoiceData.labour_hours || 0);
        const labourRate = Number(invoiceData.labour_rate || 0);
        const lineItems = invoiceData.lineItems || [];
        const totals = calculateInvoice({ ...invoiceData, lineItems, labourHours, labourRate });
        const labourCost = totals.labourCost;
        const materialsCost = totals.materialsCost;
        const equipmentCharges = Number(invoiceData.equipment_charges || 0);
        const transportCharges = Number(invoiceData.transport_charges || 0);
        const additionalCharges = Number(invoiceData.additional_charges || 0);
        const discountAmount = Number(invoiceData.discount_amount || 0);
        const gstRateVal = totals.gstRate;
        const gstRate = gstRateVal / 100.0;
        let subtotal = totals.subtotal;
        let totalTax = totals.totalTax;

        let cgst = 0, sgst = 0, igst = 0;
        let totalAmount = totals.totalAmount;

        // Handle Owner Manual Invoice Adjustment
        const isManualAdjustment = Boolean(invoiceData.is_manual_adjustment);
        const manualTotal = parseFloat(invoiceData.manual_grand_total);
        if (isManualAdjustment && !isNaN(manualTotal) && manualTotal >= 0) {
          totalAmount = manualTotal;
          subtotal = gstRate === 0 ? totalAmount : parseFloat((totalAmount / (1 + gstRate)).toFixed(2));
          totalTax = parseFloat((totalAmount - subtotal).toFixed(2));
        }

        if (invoiceData.is_inter_state) {
          igst = totalTax;
        } else {
          cgst = isManualAdjustment ? parseFloat((totalTax / 2).toFixed(2)) : totals.cgst;
          sgst = isManualAdjustment ? parseFloat((totalTax - cgst).toFixed(2)) : totals.sgst;
        }

        // Update Invoice & Increment edited_count, transition draft -> issued
        const updatedInvRes = await client.query(
          `UPDATE invoices SET
            labour_hours = $1, labour_rate = $2, labour_cost = $3, materials_cost = $4,
            equipment_charges = $5, transport_charges = $6, additional_charges = $7,
            discount_amount = $8, subtotal = $9, is_inter_state = $10, gst_rate = $11,
            cgst = $12, sgst = $13, igst = $14, total_tax = $15, total_amount = $16,
            amount_due = GREATEST(0, $16 - amount_paid), customer_notes = $17, internal_notes = $18,
            edited_count = COALESCE(edited_count, 0) + 1, updated_at = NOW(),
            status = 'issued', due_date = CURRENT_DATE + $21::integer,
            customer_name = $22, customer_email = $23, customer_phone = $24,
            payment_terms = $25, pdf_url = $26, idempotency_key = $27
           WHERE id::text = $19::text AND company_id::text = $20::text
           RETURNING *`,
          [
            labourHours, labourRate, labourCost, materialsCost,
            equipmentCharges, transportCharges, additionalCharges,
            discountAmount, subtotal, Boolean(invoiceData.is_inter_state),
            gstRateVal, cgst, sgst, igst, totalTax,
            totalAmount, invoiceData.customer_notes || 'Thank you for your business!',
            invoiceData.internal_notes || '', String(existingId), String(companyId),
            Number.parseInt(invoiceData.due_days || 15, 10),
            invoiceData.customer_name || job.customer_name || 'Customer',
            invoiceData.customer_email || job.customer_email || '',
            invoiceData.customer_phone || job.customer_phone || '',
            invoiceData.payment_terms || 'Due on receipt',
            `/api/invoices/${existingId}/pdf`, idempotencyKey
          ]
        );

        const updatedInvoice = updatedInvRes.rows[0];

        // Replace Line Items
        await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [existingId]);
        for (const item of totals.lineItems) {
          await client.query(
            `INSERT INTO invoice_items
             (invoice_id, company_id, item_type, description, hsn_code, quantity, unit_price, total_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [existingId, companyId, item.item_type || 'service', item.description || 'Service Item', item.hsn_code || '998311', item.quantity, item.unit_price, item.total_amount]
          );
        }

        const dueDays = Number.parseInt(invoiceData.due_days || 15, 10);
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + dueDays);
        await client.query(
          `INSERT INTO ar_collection_schedules
           (company_id, invoice_id, customer_id, customer_name, customer_phone, customer_email,
            invoice_amount, amount_outstanding, due_date, current_stage, is_paused)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'pre_due_3d', FALSE)
           ON CONFLICT (company_id, invoice_id) DO UPDATE SET
             customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
             customer_phone = EXCLUDED.customer_phone, customer_email = EXCLUDED.customer_email,
             invoice_amount = EXCLUDED.invoice_amount, amount_outstanding = EXCLUDED.amount_outstanding,
             due_date = EXCLUDED.due_date, is_paused = FALSE, updated_at = NOW()`,
          [companyId, existingId, job.customer_id || null, updatedInvoice.customer_name,
            updatedInvoice.customer_phone, updatedInvoice.customer_email, totalAmount, dueDate]
        );

        const pdfBuffer = await pdfInvoiceService.generateInvoicePDF(updatedInvoice, totals.lineItems);
        if (!pdfBuffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invoice PDF generation failed');

        // Create Activity Log entry for Edit (Issue 3 Requirement)
        await client.query(
          `INSERT INTO invoice_activity_logs
           (invoice_id, company_id, action_type, performed_by_type, performed_by_id, performed_by_name, created_at)
           VALUES ($1, $2, 'edited', 'owner', $3, 'Owner', NOW())`,
          [existingId, companyId, userId]
        );

        // Send Notification to Customer (Issue 4 Requirement)
        if (job.customer_id) {
          await client.query(
            `INSERT INTO notifications (user_id, company_id, type, title, message, priority, created_at)
             VALUES ($1, $2, 'invoice_updated', 'Invoice Updated 📄', $3, 'high', NOW())`,
            [job.customer_id, companyId, `Your invoice for job ${job.title} has been updated (Version 1.${updatedInvoice.edited_count}). Please review the latest version.`]
          ).catch(() => {});
        }

        await client.query('COMMIT');
        return { success: true, invoice: updatedInvoice, reason: 'invoice_updated', edited_count: updatedInvoice.edited_count };
      }

      // 3. Compute Financial Totals
      const lineItems = invoiceData.lineItems || [];
      const labourHours = Number(invoiceData.labour_hours || 0);
      const labourRate = Number(invoiceData.labour_rate || 0);
      const totals = calculateInvoice({ ...invoiceData, lineItems, labourHours, labourRate });
      const processedLineItems = totals.lineItems;
      const labourCost = totals.labourCost;
      const materialsCost = totals.materialsCost;
      const equipmentCharges = Number(invoiceData.equipment_charges || 0);
      const transportCharges = Number(invoiceData.transport_charges || 0);
      const additionalCharges = Number(invoiceData.additional_charges || 0);
      const discountAmount = Number(invoiceData.discount_amount || 0);

      let subtotal = totals.subtotal;

      const gstRateVal = totals.gstRate;
      const gstRate = gstRateVal / 100.0;
      let totalTax = totals.totalTax;

      let cgst = 0;
      let sgst = 0;
      let igst = 0;

      let totalAmount = totals.totalAmount;

      // 🚀 Handle Owner Manual Invoice Adjustment
      const isManualAdjustment = Boolean(invoiceData.is_manual_adjustment);
      const manualTotal = parseFloat(invoiceData.manual_grand_total);
      if (isManualAdjustment && !isNaN(manualTotal) && manualTotal >= 0) {
        totalAmount = manualTotal;
        subtotal = gstRate === 0 ? totalAmount : parseFloat((totalAmount / (1 + gstRate)).toFixed(2));
        totalTax = parseFloat((totalAmount - subtotal).toFixed(2));
      }

      if (invoiceData.is_inter_state) {
        igst = totalTax;
      } else {
        cgst = isManualAdjustment ? parseFloat((totalTax / 2).toFixed(2)) : totals.cgst;
        sgst = isManualAdjustment ? parseFloat((totalTax - cgst).toFixed(2)) : totals.sgst;
      }

      const dueDays = parseInt(invoiceData.due_days || 15, 10);
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + dueDays);

      // Generate Invoice Number
      const invoiceNumber = await allocateInvoiceNumber(client, companyId);

      // 4. Insert Invoice Row
      const invRes = await client.query(
        `INSERT INTO invoices
         (company_id, job_id, customer_id, customer_name, customer_email, customer_phone,
          invoice_number, version_number, is_latest, status,
          labour_hours, labour_rate, labour_cost, materials_cost, equipment_charges,
          transport_charges, additional_charges, discount_amount, subtotal,
          is_inter_state, gst_rate, cgst, sgst, igst, total_tax,
          total_amount, amount_paid, amount_due, due_date, payment_terms,
          customer_notes, internal_notes, idempotency_key, created_at, updated_at)
         VALUES
         ($1, $2, $3, $4, $5, $6, $7, 1, TRUE, 'issued',
          $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22,
          $23, 0.00, $23, $24, $25, $26, $27, $28, NOW(), NOW())
         RETURNING *`,
        [
          companyId,
          actualJobId,
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
          gstRateVal,
          cgst,
          sgst,
          igst,
          totalTax,
          totalAmount,
          dueDate,
          invoiceData.payment_terms || 'Due on receipt',
          invoiceData.customer_notes || 'Thank you for your business!',
          invoiceData.internal_notes || '',
          idempotencyKey,
        ]
      );

      const invoice = invRes.rows[0];

      // 5. Insert Line Items
      if (processedLineItems.length > 0) {
        for (const item of processedLineItems) {
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
              item.quantity,
              item.unit_price,
              item.total_amount,
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
      const pdfBuffer = await pdfInvoiceService.generateInvoicePDF(invoice, processedLineItems);
      if (!pdfBuffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invoice PDF generation failed');
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

      // Record Manual Adjustment Audit Log if enabled
      if (isManualAdjustment) {
        const origVal = parseFloat(invoiceData.original_grand_total || totalAmount);
        const diffVal = parseFloat((totalAmount - origVal).toFixed(2));
        const reasonVal = invoiceData.adjustment_reason || 'Owner Manual Adjustment';
        await client.query(
          `INSERT INTO invoice_activity_logs (invoice_id, actor_id, actor_name, action, notes, created_at)
           VALUES ($1, $2, 'Owner/Admin', 'manual_adjustment', $3, NOW())`,
          [
            invoice.id,
            userId || null,
            `Original Amount: ₹${origVal} | New Amount: ₹${totalAmount} | Difference: ₹${diffVal} | Reason: ${reasonVal}`
          ]
        ).catch(() => {});
      }

      await client.query('COMMIT');

      // Non-blocking audit log
      auditService.log({
        companyId,
        actorType: 'user',
        actorId: userId,
        actionType: isManualAdjustment ? 'invoice_manual_adjustment' : 'invoice_finalized',
        entityType: 'invoice',
        entityId: invoice.id,
        newValue: {
          invoice_number: invoiceNumber,
          total_amount: totalAmount,
          is_manual_adjustment: isManualAdjustment,
          reason: invoiceData.adjustment_reason || null
        },
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
      const idempotencyKey = updateData?.idempotency_key;
      if (!idempotencyKey) {
        const err = new Error('Invoice reissue requires an idempotency key');
        err.statusCode = 400;
        throw err;
      }
      const replay = await client.query(
        'SELECT * FROM invoices WHERE company_id::text = $1::text AND idempotency_key = $2 FOR UPDATE',
        [String(companyId), String(idempotencyKey)]
      );
      if (replay.rows.length) {
        await client.query('COMMIT');
        return { success: true, invoice: replay.rows[0], reason: 'idempotent_replay' };
      }

      // Fetch parent invoice
      const parentRes = await client.query(
        `SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [parentInvoiceId, companyId]
      );

      if (parentRes.rows.length === 0) {
        throw new Error(`Parent invoice ${parentInvoiceId} not found`);
      }

      const parent = parentRes.rows[0];
      if (Number(parent.amount_paid || 0) > 0) {
        const conflict = new Error('This invoice has recorded payments and cannot be revised automatically. Reconcile its payment history before reissuing.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const newVersionNumber = parent.version_number + 1;

      let lineItems = Array.isArray(updateData.lineItems) ? updateData.lineItems : [];
      if (!lineItems.length) {
        const existingItems = await client.query(
          'SELECT item_type, description, hsn_code, quantity, unit_price, total_amount FROM invoice_items WHERE invoice_id = $1 ORDER BY id',
          [parent.id]
        );
        lineItems = existingItems.rows;
      }
      const totals = calculateInvoice({
        lineItems,
        labourHours: updateData.labour_hours ?? parent.labour_hours ?? 0,
        labourRate: updateData.labour_rate ?? parent.labour_rate ?? 0,
        equipmentCharges: updateData.equipment_charges ?? parent.equipment_charges ?? 0,
        transportCharges: updateData.transport_charges ?? parent.transport_charges ?? 0,
        additionalCharges: updateData.additional_charges ?? parent.additional_charges ?? 0,
        discountAmount: updateData.discount_amount ?? parent.discount_amount ?? 0,
        gstRate: updateData.gst_rate ?? parent.gst_rate ?? 18,
        isInterState: updateData.is_inter_state ?? parent.is_inter_state,
      });

      // Mark parent as is_latest = FALSE
      await client.query(`UPDATE invoices SET is_latest = FALSE WHERE id = $1`, [parentInvoiceId]);

      // Calculate totals for new version
      const labourHours = Number(updateData.labour_hours ?? parent.labour_hours ?? 0);
      const labourRate = Number(updateData.labour_rate ?? parent.labour_rate ?? 0);
      const labourCost = totals.labourCost;
      const materialsCost = totals.materialsCost;
      const equipmentCharges = Number(updateData.equipment_charges ?? parent.equipment_charges ?? 0);
      const transportCharges = Number(updateData.transport_charges ?? parent.transport_charges ?? 0);
      const additionalCharges = Number(updateData.additional_charges ?? parent.additional_charges ?? 0);
      const discountAmount = Number(updateData.discount_amount ?? parent.discount_amount ?? 0);
      const subtotal = totals.subtotal;
      const gstRate = totals.gstRate;
      const totalTax = totals.totalTax;
      const { cgst, sgst, igst } = totals;
      const isInterState = Boolean(updateData.is_inter_state ?? parent.is_inter_state);
      const totalAmount = totals.totalAmount;

      // Insert New Invoice Version
      const newInvRes = await client.query(
        `INSERT INTO invoices
         (company_id, job_id, customer_id, customer_name, customer_email, customer_phone,
          invoice_number, version_number, parent_invoice_id, is_latest, status,
          labour_hours, labour_rate, labour_cost, materials_cost, equipment_charges,
          transport_charges, additional_charges, discount_amount, subtotal,
          is_inter_state, gst_rate, cgst, sgst, igst, total_tax,
          total_amount, amount_paid, amount_due, due_date, payment_terms,
          customer_notes, internal_notes, idempotency_key, created_at, updated_at)
         VALUES
         ($1, $2, $3, $4, $5, $6,
          $7, $8, $9, TRUE, 'issued',
          $10, $11, $12, $13, $14,
          $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24,
          $25, $26, $25, $27, $28,
          $29, $30, $31, NOW(), NOW())
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
          gstRate,
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
          idempotencyKey,
        ]
      );

      const newInvoice = newInvRes.rows[0];

      // Insert updated line items
      for (const item of totals.lineItems) {
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
            item.quantity,
            item.unit_price,
            item.total_amount,
          ]
        );
      }

      // Resolve the selected issue, or the latest open issue for this invoice.
      const disputeToResolve = disputeId || (await client.query(
        `SELECT id FROM invoice_disputes WHERE invoice_id = $1 AND company_id::text = $2::text
         AND status IN ('open', 'under_review') ORDER BY created_at DESC LIMIT 1`,
        [parent.id, String(companyId)]
      )).rows[0]?.id;
      if (disputeToResolve) {
        await client.query(
          `UPDATE invoice_disputes 
           SET status = 'resolved', resolved_in_version = $1, updated_at = NOW() 
           WHERE id = $2 AND company_id = $3`,
          [newVersionNumber, disputeToResolve, companyId]
        );
      }

      // Move or create the AR schedule for the revised outstanding invoice.
      await client.query(
        `UPDATE ar_collection_schedules
         SET invoice_id = $1, invoice_amount = $2, amount_outstanding = $2, is_paused = FALSE, updated_at = NOW()
         WHERE company_id::text = $3::text AND invoice_id::text = $4::text`,
        [newInvoice.id, totalAmount, String(companyId), String(parentInvoiceId)]
      );
      await client.query(
        `INSERT INTO ar_collection_schedules
         (company_id, invoice_id, customer_id, customer_name, customer_phone, customer_email,
          invoice_amount, amount_outstanding, due_date, current_stage, is_paused)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'pre_due_3d', FALSE)
         ON CONFLICT (company_id, invoice_id) DO UPDATE SET
           invoice_amount = EXCLUDED.invoice_amount, amount_outstanding = EXCLUDED.amount_outstanding,
           due_date = EXCLUDED.due_date, is_paused = FALSE, updated_at = NOW()`,
        [companyId, newInvoice.id, parent.customer_id || null, parent.customer_name || 'Customer',
          parent.customer_phone || '', parent.customer_email || '', totalAmount, parent.due_date]
      );
      const pdfUrl = `/api/invoices/${newInvoice.id}/pdf`;
      await client.query('UPDATE invoices SET pdf_url = $1 WHERE id = $2 AND company_id::text = $3::text', [pdfUrl, newInvoice.id, String(companyId)]);
      newInvoice.pdf_url = pdfUrl;
      const pdf = await pdfInvoiceService.generateInvoicePDF(newInvoice, totals.lineItems);
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invoice PDF generation failed');

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
      // Safety net: resolve company_id from invoice if caller didn't provide it (e.g. customer portal)
      let resolvedCompanyId = companyId;
      if (!resolvedCompanyId) {
        const invRow = await pool.query(`SELECT company_id FROM invoices WHERE id = $1`, [invoiceId]);
        if (invRow.rows.length > 0) resolvedCompanyId = invRow.rows[0].company_id;
      }
      if (!resolvedCompanyId) {
        console.warn(`invoiceService.logActivity: skipping — could not resolve company_id for invoice ${invoiceId}`);
        return;
      }

      await pool.query(
        `INSERT INTO invoice_activity_logs
         (invoice_id, company_id, action_type, performed_by_type, performed_by_id, performed_by_name, ip_address, user_agent, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [invoiceId, resolvedCompanyId, actionType, performedByType, performedById || null, performedByName || 'Customer', ipAddress || '', userAgent || '']
      );

      if (actionType === 'viewed') {
        await pool.query(
          `UPDATE invoices SET viewed_at = NOW(), status = CASE WHEN status = 'issued' THEN 'viewed' ELSE status END WHERE id = $1`,
          [invoiceId]
        );
      } else if (actionType === 'downloaded') {
        await pool.query(
          `UPDATE invoices SET downloaded_at = NOW() WHERE id = $1`,
          [invoiceId]
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

        // Update Job to billed_and_closed if tied to a job
        if (invoice.job_id) {
          await client.query(
            `UPDATE jobs SET status = 'billed_and_closed' WHERE id = $1 AND company_id::text = $2::text`,
            [invoice.job_id, companyId]
          );
        }
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

      // Always look up company_id and customer_id from the invoice itself.
      // The customer portal doesn't pass them, so we resolve them server-side.
      const invRow = await client.query(
        `SELECT company_id, customer_id FROM invoices WHERE id = $1`,
        [invoiceId]
      );
      if (invRow.rows.length === 0) throw new Error('Invoice not found');
      const resolvedCompanyId   = companyId   || invRow.rows[0].company_id;
      const resolvedCustomerId  = customerId  || invRow.rows[0].customer_id;

      const disputeRes = await client.query(
        `INSERT INTO invoice_disputes
         (invoice_id, company_id, customer_id, issue_category, description, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'open', NOW())
         RETURNING *`,
        [invoiceId, resolvedCompanyId, resolvedCustomerId, issueCategory, description]
      );

      // Update invoice status to disputed
      await client.query(
        `UPDATE invoices SET status = 'disputed', updated_at = NOW() WHERE id = $1`,
        [invoiceId]
      );

      // Pause AR reminder schedule (best-effort)
      await client.query(
        `UPDATE ar_collection_schedules SET is_paused = TRUE, updated_at = NOW() WHERE invoice_id = $1`,
        [invoiceId]
      ).catch(() => {});

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

  /**
   * Issues a Direct / Walk-in Invoice for over-the-counter or ad-hoc sales.
   * Completely decoupled from jobs.
   * Handles customer creation/lookup, line items, inventory deduction, GST + discount,
   * atomic invoice number generation, immediate counter payment or AR scheduling,
   * and PDF generation.
   */
  static async createDirectInvoice({ companyId, userId, invoiceData }) {
    const client = await pool.connect();
    let idempotencyKey = null;
    try {
      await client.query('BEGIN');
      idempotencyKey = invoiceData.idempotency_key || null;
      if (!idempotencyKey) {
        const err = new Error('Direct invoice creation requires an idempotency key');
        err.statusCode = 400;
        throw err;
      }
      if (idempotencyKey) {
        const previous = await client.query(
          `SELECT * FROM invoices WHERE company_id::text = $1::text AND idempotency_key = $2 FOR UPDATE`,
          [String(companyId), String(idempotencyKey)]
        );
        if (previous.rows.length) {
          const items = await client.query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id', [previous.rows[0].id]);
          await client.query('COMMIT');
          return { success: true, invoice: previous.rows[0], lineItems: items.rows, payment: null, pdfUrl: previous.rows[0].pdf_url, idempotentReplay: true };
        }
      }

      // 1. Customer resolution (existing or walk-in inline)
      let customerId = invoiceData.customer_id || null;
      let customerName = (invoiceData.customer_name || 'Walk-in Customer').trim();
      let customerPhone = (invoiceData.customer_phone || '').trim();
      let customerEmail = (invoiceData.customer_email || '').trim();
      let customerAddress = (invoiceData.customer_address || '').trim();
      let customerGstin = (invoiceData.customer_gstin || '').trim();

      if (customerId) {
        const customerResult = await client.query(
          `SELECT id, name, email, phone FROM customers WHERE id = $1 AND company_id = $2`,
          [customerId, companyId]
        );
        if (!customerResult.rows.length) throw new Error('Customer not found for this company');
        customerName = customerResult.rows[0].name || customerName;
        customerEmail = customerResult.rows[0].email || customerEmail;
        customerPhone = customerResult.rows[0].phone || customerPhone;
      } else if (customerName && customerEmail) {
        // Try to match or auto-link customer by email for this company
        const existingCustomer = await client.query(
          `SELECT id FROM customers WHERE LOWER(email) = LOWER($1) AND company_id = $2 AND is_deleted = FALSE LIMIT 1`,
          [customerEmail, companyId]
        );
        if (existingCustomer.rows.length > 0) {
          customerId = existingCustomer.rows[0].id;
        } else if (invoiceData.auto_create_customer) {
          const newCustomer = await client.query(
            `INSERT INTO customers (name, email, phone, company_id) VALUES ($1, $2, $3, $4) RETURNING id`,
            [customerName, customerEmail, customerPhone, companyId]
          );
          customerId = newCustomer.rows[0].id;
        }
      }

      // 2. Line Items Breakdown & Cost Calculation
      const rawLineItems = Array.isArray(invoiceData.lineItems) ? invoiceData.lineItems : [];
      if (rawLineItems.length === 0) {
        throw new Error('At least one line item is required to generate an invoice');
      }

      const totals = calculateInvoice({ ...invoiceData, lineItems: rawLineItems });
      const materialsCost = totals.materialsCost;
      const labourCost = totals.labourCost;
      const processedLineItems = totals.lineItems.map((item) => {
        const itemType = ['service', 'labour', 'labor', 'material', 'equipment', 'transport', 'extra'].includes(String(item.item_type).toLowerCase())
          ? String(item.item_type).toLowerCase() : 'service';
        return {
          item_type: itemType,
          description: String(item.description || 'Item Description').trim(),
          hsn_code: (item.hsn_code || (itemType === 'material' ? '847990' : '998311')).trim(),
          quantity: item.quantity,
          unit_price: item.unit_price,
          total_amount: item.total_amount,
          inventory_item_id: item.inventory_item_id || null,
        };
      });

      // Additional charges & discounts
      const equipmentCharges = parseFloat(invoiceData.equipment_charges || 0);
      const transportCharges = parseFloat(invoiceData.transport_charges || 0);
      const additionalCharges = parseFloat(invoiceData.additional_charges || 0);
      const discountAmount = Math.max(0, parseFloat(invoiceData.discount_amount || 0));

      const subtotal = totals.subtotal;

      // 3. GST Calculation
      const isInterState = Boolean(invoiceData.is_inter_state);
      const gstRateVal = parseFloat(invoiceData.gst_rate !== undefined ? invoiceData.gst_rate : 18.0);
      const gstRateFrac = gstRateVal / 100.0;
      const totalTax = totals.totalTax;

      let cgst = 0;
      let sgst = 0;
      let igst = 0;

      if (isInterState) {
        igst = totalTax;
      } else {
        cgst = totals.cgst;
        sgst = totals.sgst;
      }

      const totalAmount = totals.totalAmount;

      // 4. Due Date
      const dueDays = parseInt(invoiceData.due_days || 0, 10);
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + dueDays);

      // 5. Atomic Sequential Invoice Number Generation
      const invoiceNumber = await allocateInvoiceNumber(client, companyId);

      // 6. Payment Status Handling
      const isPaidNow = invoiceData.payment_status === 'paid';
      const paymentMethod = invoiceData.payment_method || (isPaidNow ? 'cash' : null);
      const amountPaid = isPaidNow ? totalAmount : 0;
      const amountDue = isPaidNow ? 0 : totalAmount;
      const status = isPaidNow ? 'paid' : 'issued';

      // 7. Insert Invoice Row
      const insertInvRes = await client.query(
        `INSERT INTO invoices
         (company_id, job_id, customer_id, customer_name, customer_email, customer_phone,
          customer_address, customer_gstin, invoice_type, invoice_number, version_number,
          is_latest, status, payment_method, labour_hours, labour_rate, labour_cost,
          materials_cost, equipment_charges, transport_charges, additional_charges,
          discount_amount, subtotal, is_inter_state, gst_rate, cgst, sgst, igst,
          total_tax, total_amount, amount_paid, amount_due, due_date, payment_terms,
          customer_notes, internal_notes, idempotency_key, created_at, updated_at)
         VALUES
         ($1, NULL, $2, $3, $4, $5,
          $6, $7, $8, $9, 1,
          TRUE, $10, $11, 0, 0, $12,
          $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23,
          $24, $25, $26, $27, $28, $29,
          $30, $31, $32, NOW(), NOW())
         RETURNING *`,
        [
          companyId, customerId, customerName, customerEmail, customerPhone,
          customerAddress, customerGstin, invoiceData.invoice_type || 'walk_in', invoiceNumber,
          status, paymentMethod, labourCost,
          materialsCost, equipmentCharges, transportCharges, additionalCharges,
          discountAmount, subtotal, isInterState, gstRateVal, cgst, sgst, igst,
          totalTax, totalAmount, amountPaid, amountDue, dueDate, invoiceData.payment_terms || (isPaidNow ? 'Immediate Payment' : 'Due on receipt'),
          invoiceData.customer_notes || 'Thank you for your business!', invoiceData.internal_notes || '', idempotencyKey
        ]
      );

      const invoice = insertInvRes.rows[0];

      // 8. Insert Line Items & Auto-Deduct Inventory
      for (const item of processedLineItems) {
        await client.query(
          `INSERT INTO invoice_items
           (invoice_id, company_id, item_type, description, hsn_code, quantity, unit_price, total_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [invoice.id, companyId, item.item_type, item.description, item.hsn_code, item.quantity, item.unit_price, item.total_amount]
        );

        // Deduct from inventory if linked
        if (item.inventory_item_id) {
          const stockUpdate = await client.query(
            `UPDATE inventory_items 
             SET quantity = quantity - $1, updated_at = NOW()
             WHERE id = $2 AND company_id::text = $3::text AND quantity >= $1 RETURNING id`,
            [item.quantity, item.inventory_item_id, String(companyId)]
          );
          if (!stockUpdate.rows.length) throw new Error(`Insufficient or unavailable inventory for ${item.description}`);
        }
      }

      // 9. Payment Record (if paid at counter) or AR Schedule (if unpaid)
      let paymentRecord = null;
      if (isPaidNow) {
        const payRes = await client.query(
          `INSERT INTO invoice_payments
           (invoice_id, company_id, payment_method, transaction_reference, amount, notes, recorded_by, payment_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           RETURNING *`,
          [
            invoice.id, companyId, paymentMethod,
            invoiceData.transaction_reference || 'COUNTER_SALE',
            totalAmount, invoiceData.payment_notes || 'Immediate counter payment',
            userId || null
          ]
        );
        paymentRecord = payRes.rows[0];
      } else {
        // Insert into AR schedule for unpaid walk-in
        await client.query(
          `INSERT INTO ar_collection_schedules
           (company_id, invoice_id, customer_id, customer_name, customer_phone, customer_email,
            invoice_amount, amount_outstanding, due_date, current_stage, is_paused)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'pre_due_3d', FALSE)
           ON CONFLICT (company_id, invoice_id) DO UPDATE
           SET invoice_amount = EXCLUDED.invoice_amount, amount_outstanding = EXCLUDED.amount_outstanding`,
          [
            companyId, invoice.id, customerId, customerName,
            customerPhone, customerEmail, totalAmount, dueDate
          ]
        );
      }

      // 10. Generate PDF link
      const pdfUrl = `/api/invoices/${invoice.id}/pdf`;
      await client.query(`UPDATE invoices SET pdf_url = $1 WHERE id = $2`, [pdfUrl, invoice.id]);
      invoice.pdf_url = pdfUrl;
      const pdfBuffer = await pdfInvoiceService.generateInvoicePDF(invoice, processedLineItems);
      if (!pdfBuffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invoice PDF generation failed');

      // 11. Log Activity
      await client.query(
        `INSERT INTO invoice_activity_logs
         (invoice_id, company_id, action_type, performed_by_type, performed_by_id, performed_by_name, created_at)
         VALUES ($1, $2, 'created', 'owner', $3, 'Owner', NOW())`,
        [invoice.id, companyId, userId || null]
      ).catch(() => {});

      await client.query('COMMIT');

      return {
        success: true,
        invoice,
        lineItems: processedLineItems,
        payment: paymentRecord,
        pdfUrl
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505' && idempotencyKey) {
        const previous = await client.query(
          `SELECT * FROM invoices WHERE company_id::text = $1::text AND idempotency_key = $2`,
          [String(companyId), String(idempotencyKey)]
        ).catch(() => ({ rows: [] }));
        if (previous.rows.length) {
          const items = await client.query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id', [previous.rows[0].id]).catch(() => ({ rows: [] }));
          return { success: true, invoice: previous.rows[0], lineItems: items.rows, payment: null, pdfUrl: previous.rows[0].pdf_url, idempotentReplay: true };
        }
      }
      console.error('invoiceService.createDirectInvoice error:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

InvoiceService.allocateInvoiceNumber = allocateInvoiceNumber;

module.exports = InvoiceService;
