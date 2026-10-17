/**
 * Backward-compatible billing wrapper. Invoice persistence belongs to invoiceService.
 * Creating a draft is explicit; job completion no longer calls this automatically.
 */
'use strict';

const invoiceService = require('./invoiceService');

async function generateInvoice(jobId, companyId, userId = null) {
  try {
    return await invoiceService.createJobDraft({ companyId, jobId, userId });
  } catch (err) {
    console.error(`billingService.generateInvoice compatibility wrapper failed for job ${jobId}:`, err.message);
    return null;
  }
}

module.exports = { generateInvoice };
