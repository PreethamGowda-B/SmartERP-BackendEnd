const { pool } = require('../db');
const ProviderFactory = require('../ai/providers/provider.factory');
const redisClient = require('../utils/redis');

class GstReconciliationService {
  /**
   * Normalizes invoice numbers for fuzzy string comparison.
   * Strips slashes, dashes, spaces, leading zeros, and converts to uppercase.
   */
  static normalizeInvoiceNumber(invNo) {
    if (!invNo || typeof invNo !== 'string') return '';
    return invNo
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .replace(/^0+/, '');
  }

  /**
   * Computes Levenshtein Distance Ratio between two normalized strings.
   * Returns a value between 0.00 and 1.00.
   */
  static computeLevenshteinRatio(str1, str2) {
    const s1 = this.normalizeInvoiceNumber(str1);
    const s2 = this.normalizeInvoiceNumber(str2);
    if (!s1 && !s2) return 1.0;
    if (!s1 || !s2) return 0.0;
    if (s1 === s2) return 1.0;

    const track = Array(s2.length + 1)
      .fill(null)
      .map(() => Array(s1.length + 1).fill(null));

    for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
    for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;

    for (let j = 1; j <= s2.length; j += 1) {
      for (let i = 1; i <= s1.length; i += 1) {
        const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
        track[j][i] = Math.min(
          track[j][i - 1] + 1,
          track[j - 1][i] + 1,
          track[j - 1][i - 1] + indicator
        );
      }
    }

    const distance = track[s2.length][s1.length];
    const maxLength = Math.max(s1.length, s2.length);
    return maxLength === 0 ? 1.0 : 1.0 - distance / maxLength;
  }

  /**
   * Deterministic Mathematical Confidence Scoring Algorithm.
   * STRICT GUARANTEE: Mathematical formula only. LLM CANNOT set score.
   */
  static calculateConfidenceScore({ booksItem, portalItem, canonicalTolerance = 5.00 }) {
    // Hard Gate 1: Supplier GSTIN must match
    const gstin1 = (booksItem.supplierGstin || '').trim().toUpperCase();
    const gstin2 = (portalItem.supplierGstin || '').trim().toUpperCase();
    if (gstin1 !== gstin2) {
      return { score: 0.0, matchStatus: 'missing_in_gstr', variance: 0.0 };
    }

    // 1. Invoice Number Levenshtein Similarity (Weight: 40%)
    const sInv = this.computeLevenshteinRatio(booksItem.invoiceNumber, portalItem.invoiceNumber);

    // 2. Taxable Value Delta (Weight: 30%)
    const valBooks = parseFloat(booksItem.taxableValue || 0);
    const valPortal = parseFloat(portalItem.taxableValue || 0);
    const valDiff = Math.abs(valBooks - valPortal);
    const sVal = valBooks > 0 ? Math.max(0, 1.0 - valDiff / valBooks) : (valDiff === 0 ? 1.0 : 0.0);

    // 3. Tax Amount Delta (Weight: 20%)
    const taxBooks = parseFloat(booksItem.totalTax || (booksItem.cgst + booksItem.sgst + booksItem.igst) || 0);
    const taxPortal = parseFloat(portalItem.totalTax || (portalItem.cgst + portalItem.sgst + portalItem.igst) || 0);
    const taxDiff = Math.abs(taxBooks - taxPortal);
    const sTax = taxBooks > 0 ? Math.max(0, 1.0 - taxDiff / taxBooks) : (taxDiff === 0 ? 1.0 : 0.0);

    // 4. Date Proximity (Weight: 10%)
    let sDate = 1.0;
    if (booksItem.invoiceDate && portalItem.invoiceDate) {
      const d1 = new Date(booksItem.invoiceDate);
      const d2 = new Date(portalItem.invoiceDate);
      const diffDays = Math.abs((d1 - d2) / (1000 * 60 * 60 * 24));
      if (diffDays <= 7) sDate = 1.0;
      else if (diffDays <= 60) sDate = 1.0 - (diffDays - 7) / 53.0;
      else sDate = 0.0;
    }

    // Mathematical Weighted Score Calculation
    const weightedScore = (0.40 * sInv + 0.30 * sVal + 0.20 * sTax + 0.10 * sDate) * 100.0;
    const finalScore = parseFloat(weightedScore.toFixed(2));
    const netVariance = parseFloat((valDiff + taxDiff).toFixed(2));

    // Decision Matrix Categorization (Zero Unhandled Fall-Throughs)
    let matchStatus = 'missing_in_gstr';
    if (finalScore === 100.0 && netVariance === 0.0) {
      matchStatus = 'exact_match';
    } else if (finalScore >= 90.0 && netVariance <= canonicalTolerance) {
      matchStatus = 'fuzzy_match';
    } else if (finalScore >= 90.0 && netVariance > canonicalTolerance) {
      matchStatus = 'tax_mismatch';
    } else if (finalScore >= 70.0 && netVariance <= canonicalTolerance) {
      matchStatus = 'fuzzy_match';
    } else if (finalScore >= 70.0 && netVariance > canonicalTolerance) {
      matchStatus = 'tax_mismatch';
    } else {
      matchStatus = 'missing_in_gstr';
    }

    return {
      score: finalScore,
      matchStatus,
      variance: netVariance,
    };
  }

  /**
   * Generates AI Match Reasoning using Groq Llama 3.3 70B.
   * LLM evaluates mathematical output and generates a human audit line.
   */
  static async generateAIMatchReasoning({ booksItem, portalItem, scoreResult }) {
    try {
      const provider = ProviderFactory.getProvider();
      const prompt = `You are an expert Indian GST Tax Audit Assistant.
Summarize the match comparison below in EXACTLY ONE clear audit sentence.
Do NOT modify the score or status provided.

Books Invoice: ${booksItem.invoiceNumber || 'N/A'}, Date: ${booksItem.invoiceDate || 'N/A'}, Taxable: ₹${booksItem.taxableValue}
Portal Invoice: ${portalItem.invoiceNumber || 'N/A'}, Date: ${portalItem.invoiceDate || 'N/A'}, Taxable: ₹${portalItem.taxableValue}
Mathematical Score: ${scoreResult.score}%, Status: ${scoreResult.matchStatus}, Variance: ₹${scoreResult.variance}
`.trim();

      const completion = await provider.generateCompletion({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      return completion.content ? completion.content.trim() : `Match evaluated with confidence score ${scoreResult.score}%.`;
    } catch (err) {
      return `Deterministic match score ${scoreResult.score}% computed with variance ₹${scoreResult.variance}.`;
    }
  }

  /**
   * Initializes a new Versioned Reconciliation Run.
   * Sets previous runs for the period to is_latest = FALSE.
   */
  static async createReconciliationRun({ companyId, userId, financialPeriod, gstrType = 'GSTR_2B', rawPayloadS3Key = null }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_company_id', $1::text, true)`, [String(companyId)]);

      // 1. Mark previous runs for this period and type as not latest
      await client.query(
        `UPDATE gst_reconciliation_runs 
         SET is_latest = FALSE 
         WHERE company_id = $1 AND financial_period = $2 AND gstr_type = $3`,
        [companyId, financialPeriod, gstrType]
      );

      // 2. Fetch latest version number
      const verRes = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version 
         FROM gst_reconciliation_runs 
         WHERE company_id = $1 AND financial_period = $2 AND gstr_type = $3`,
        [companyId, financialPeriod, gstrType]
      );
      const nextVersion = verRes.rows[0].next_version;

      // 3. Create new run header
      const res = await client.query(
        `INSERT INTO gst_reconciliation_runs 
         (company_id, created_by, financial_period, gstr_type, version, is_latest, raw_payload_s3_key, raw_payload_expires_at, status)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, NOW() + INTERVAL '90 days', 'processing')
         RETURNING *`,
        [companyId, userId, financialPeriod, gstrType, nextVersion, rawPayloadS3Key]
      );

      await client.query('COMMIT');
      return res.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Bulk Batch Reconciliation Processor with Redis Checkpointing.
   */
  static async processReconciliationBatch({ runId, companyId, booksInvoices = [], portalInvoices = [] }) {
    const checkpointKey = `gst:job:${runId}:checkpoint`;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_company_id', $1::text, true)`, [String(companyId)]);

      // Fetch Company Tolerance Settings
      const settingsRes = await client.query(
        `SELECT canonical_tolerance_amount, auto_approve_confidence_threshold 
         FROM gst_company_settings WHERE company_id = $1`,
        [companyId]
      );
      const canonicalTolerance = settingsRes.rows[0] ? parseFloat(settingsRes.rows[0].canonical_tolerance_amount) : 5.00;

      // Check Redis Checkpoint
      const lastIndexStr = await redisClient.hget(checkpointKey, 'last_processed_index');
      let startIndex = lastIndexStr ? parseInt(lastIndexStr, 10) : 0;

      let totalMatched = 0;
      let totalMismatched = 0;
      let totalClaimed = 0;
      let totalBlocked = 0;

      for (let i = startIndex; i < booksInvoices.length; i++) {
        const booksItem = booksInvoices[i];
        
        // Find best matching portal item
        let bestMatch = null;
        let highestScoreResult = { score: 0.0, matchStatus: 'missing_in_gstr', variance: 0.0 };

        for (const portalItem of portalInvoices) {
          const scoreResult = this.calculateConfidenceScore({ booksItem, portalItem, canonicalTolerance });
          if (scoreResult.score > highestScoreResult.score) {
            highestScoreResult = scoreResult;
            bestMatch = portalItem;
          }
        }

        const matchStatus = highestScoreResult.matchStatus;
        const confidenceScore = highestScoreResult.score;
        const varianceAmount = highestScoreResult.variance;

        let reasoning = '';
        if (matchStatus === 'fuzzy_match' || matchStatus === 'tax_mismatch') {
          reasoning = await this.generateAIMatchReasoning({
            booksItem,
            portalItem: bestMatch || {},
            scoreResult: highestScoreResult
          });
        } else if (matchStatus === 'exact_match') {
          reasoning = 'Exact match on Supplier GSTIN, invoice number, date, and tax amounts.';
        } else {
          reasoning = 'Invoice missing in GSTR-2B statement or confidence score below matching threshold.';
        }

        const totalTax = parseFloat(booksItem.totalTax || 0);
        if (matchStatus === 'exact_match' || matchStatus === 'fuzzy_match') {
          totalMatched += 1;
          totalClaimed += totalTax;
        } else {
          totalMismatched += 1;
          totalBlocked += totalTax;
        }

        // Insert item record
        await client.query(
          `INSERT INTO gst_reconciliation_items
           (reconciliation_run_id, company_id, supplier_gstin, supplier_name, invoice_number_books, invoice_number_portal,
            invoice_date_books, invoice_date_portal, taxable_value_books, taxable_value_portal,
            cgst_books, cgst_portal, sgst_books, sgst_portal, igst_books, igst_portal,
            variance_amount, match_status, confidence_score, ai_match_reasoning)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
          [
            runId, companyId, booksItem.supplierGstin, booksItem.supplierName || 'N/A',
            booksItem.invoiceNumber, bestMatch ? bestMatch.invoiceNumber : null,
            booksItem.invoiceDate || null, bestMatch ? bestMatch.invoiceDate : null,
            booksItem.taxableValue || 0, bestMatch ? bestMatch.taxableValue : 0,
            booksItem.cgst || 0, bestMatch ? bestMatch.cgst : 0,
            booksItem.sgst || 0, bestMatch ? bestMatch.sgst : 0,
            booksItem.igst || 0, bestMatch ? bestMatch.igst : 0,
            varianceAmount, matchStatus, confidenceScore, reasoning
          ]
        );

        // Update Redis Checkpoint every 250 items
        if ((i + 1) % 250 === 0 || i === booksInvoices.length - 1) {
          await redisClient.hset(checkpointKey, 'last_processed_index', i + 1);
        }
      }

      // Update Header Record
      await client.query(
        `UPDATE gst_reconciliation_runs
         SET total_books_invoices = $1, total_portal_invoices = $2, total_matched = $3,
             total_mismatched = $4, total_itc_claimed = $5, total_itc_blocked = $6, status = 'completed', updated_at = NOW()
         WHERE id = $7`,
        [booksInvoices.length, portalInvoices.length, totalMatched, totalMismatched, totalClaimed, totalBlocked, runId]
      );

      await client.query('COMMIT');
      await redisClient.del(checkpointKey); // Cleanup checkpoint on success

      return { success: true, runId, totalMatched, totalMismatched };
    } catch (err) {
      await client.query('ROLLBACK');
      await client.query(`UPDATE gst_reconciliation_runs SET status = 'failed' WHERE id = $1`, [runId]);
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = GstReconciliationService;
