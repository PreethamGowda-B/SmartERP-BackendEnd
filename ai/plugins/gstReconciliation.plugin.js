const BasePlugin = require("./base.plugin");
const { pool } = require("../../db");

class GSTReconciliationPlugin extends BasePlugin {
  constructor() {
    super("GSTReconciliationPlugin", "Provides tools for GST GSTR-2B reconciliation, ITC tracking, and supplier compliance.");

    this.registerTool("get_gst_reconciliation_summary", "Retrieves summary metrics for a GSTR-2B reconciliation period.", {
      type: "object",
      properties: {
        financialPeriod: { type: "string", description: "Financial period in YYYY-MM format, e.g. 2026-07" },
      },
      required: ["financialPeriod"],
    }, ["owner", "admin", "hr"], this.getReconciliationSummary.bind(this));

    this.registerTool("list_unmatched_gst_invoices", "Lists invoices missing from GSTR-2B or having tax mismatches.", {
      type: "object",
      properties: {
        financialPeriod: { type: "string", description: "Financial period YYYY-MM" },
        matchStatus: { type: "string", description: "Filter status: missing_in_gstr, tax_mismatch, fuzzy_match" },
      },
      required: ["financialPeriod"],
    }, ["owner", "admin"], this.listUnmatchedInvoices.bind(this));
  }

  async getReconciliationSummary(params, context) {
    const companyId = context.user.companyId;
    const res = await pool.query(
      `SELECT * FROM gst_reconciliation_runs 
       WHERE company_id = $1 AND financial_period = $2 AND is_latest = TRUE`,
      [companyId, params.financialPeriod]
    );

    if (res.rows.length === 0) {
      return { success: false, message: `No GSTR-2B reconciliation run found for period ${params.financialPeriod}.` };
    }

    const run = res.rows[0];
    return {
      success: true,
      period: run.financial_period,
      gstrType: run.gstr_type,
      totalBooksInvoices: run.total_books_invoices,
      totalMatched: run.total_matched,
      totalMismatched: run.total_mismatched,
      eligibleItcClaimed: run.total_itc_claimed,
      blockedItcAtRisk: run.total_itc_blocked,
      status: run.status,
    };
  }

  async listUnmatchedInvoices(params, context) {
    const companyId = context.user.companyId;
    let query = `
      SELECT i.* 
      FROM gst_reconciliation_items i
      JOIN gst_reconciliation_runs r ON i.reconciliation_run_id = r.id
      WHERE i.company_id = $1 AND r.financial_period = $2 AND r.is_latest = TRUE
    `;
    const values = [companyId, params.financialPeriod];

    if (params.matchStatus) {
      query += ` AND i.match_status = $3`;
      values.push(params.matchStatus);
    } else {
      query += ` AND i.match_status IN ('missing_in_gstr', 'tax_mismatch')`;
    }

    query += ` ORDER BY i.variance_amount DESC LIMIT 50`;

    const res = await pool.query(query, values);
    return {
      success: true,
      count: res.rows.length,
      unmatchedInvoices: res.rows.map((row) => ({
        supplierGstin: row.supplier_gstin,
        supplierName: row.supplier_name,
        invoiceNumberBooks: row.invoice_number_books,
        taxableBooks: row.taxable_value_books,
        matchStatus: row.match_status,
        variance: row.variance_amount,
        aiReasoning: row.ai_match_reasoning,
      })),
    };
  }
}

module.exports = GSTReconciliationPlugin;
