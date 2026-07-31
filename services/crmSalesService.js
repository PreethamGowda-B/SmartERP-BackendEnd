const { pool } = require('../db');
const ProviderFactory = require('../ai/providers/provider.factory');

class CrmSalesService {
  /**
   * Deterministic Predictive Lead Scoring Engine.
   * Calculates score (0-100) and priority category ('cold', 'warm', 'hot').
   */
  static calculateLeadScore({ dealValue = 0, companyName, email, phone }) {
    let score = 30; // base score

    const val = parseFloat(dealValue || 0);
    if (val >= 1000000) score += 40;
    else if (val >= 250000) score += 25;
    else if (val >= 50000) score += 15;

    if (companyName && companyName.trim().length > 2) score += 15;
    if (email && (email.endsWith('.com') || email.endsWith('.in') || email.includes('@corp'))) score += 10;
    if (phone && phone.trim().length >= 10) score += 5;

    const finalScore = Math.min(100, Math.max(0, score));

    let priority = 'cold';
    if (finalScore >= 75) priority = 'hot';
    else if (finalScore >= 40) priority = 'warm';

    return { score: finalScore, priority };
  }

  /**
   * Fetches CRM Leads grouped by Kanban pipeline stages.
   */
  static async getPipelineSummary(companyId) {
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_company_id = '${companyId}'`);

      const res = await client.query(
        `SELECT l.*, u.name as assigned_user_name
         FROM crm_leads_enhanced l
         LEFT JOIN users u ON l.assigned_to = u.id
         WHERE l.company_id = $1
         ORDER BY l.lead_score DESC, l.created_at DESC`,
        [companyId]
      );

      const pipeline = {
        new_lead: [],
        contacted: [],
        proposal_sent: [],
        negotiation: [],
        closed_won: [],
        closed_lost: [],
      };

      res.rows.forEach((lead) => {
        const stage = lead.stage || 'new_lead';
        if (pipeline[stage]) {
          pipeline[stage].push(lead);
        }
      });

      return { success: true, count: res.rows.length, pipeline };
    } finally {
      client.release();
    }
  }

  /**
   * Ingests a new CRM lead and computes lead score.
   */
  static async createLead({ companyId, userId, leadName, companyName, email, phone, dealValue, stage = 'new_lead' }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_company_id = '${companyId}'`);

      const { score, priority } = this.calculateLeadScore({ dealValue, companyName, email, phone });

      const leadRes = await client.query(
        `INSERT INTO crm_leads_enhanced
         (company_id, assigned_to, lead_name, company_name, email, phone, deal_value, lead_score, priority, stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [companyId, userId, leadName, companyName || null, email, phone || null, parseFloat(dealValue || 0), score, priority, stage]
      );

      const lead = leadRes.rows[0];

      // Log activity
      await client.query(
        `INSERT INTO crm_lead_activities (lead_id, company_id, created_by, activity_type, notes)
         VALUES ($1, $2, $3, 'lead_created', $4)`,
        [lead.id, companyId, userId, `Lead ingested with predictive score ${score} (${priority.toUpperCase()}).`]
      );

      await client.query('COMMIT');
      return lead;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Updates pipeline stage for a lead.
   */
  static async updateLeadStage({ companyId, userId, leadId, newStage }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_company_id = '${companyId}'`);

      const leadRes = await client.query(
        `UPDATE crm_leads_enhanced
         SET stage = $1, last_contacted_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [newStage, leadId, companyId]
      );

      if (leadRes.rows.length === 0) {
        throw new Error('Lead not found.');
      }

      await client.query(
        `INSERT INTO crm_lead_activities (lead_id, company_id, created_by, activity_type, notes)
         VALUES ($1, $2, $3, 'stage_change', $4)`,
        [leadId, companyId, userId, `Moved lead stage to ${newStage.replace('_', ' ').toUpperCase()}.`]
      );

      await client.query('COMMIT');
      return leadRes.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Generates a customized AI B2B Sales Proposal via Groq LLM.
   */
  static async generateAiProposal({ companyId, userId, leadId }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_company_id = '${companyId}'`);

      const leadRes = await client.query(
        `SELECT * FROM crm_leads_enhanced WHERE id = $1 AND company_id = $2`,
        [leadId, companyId]
      );

      if (leadRes.rows.length === 0) {
        throw new Error('Lead not found.');
      }

      const lead = leadRes.rows[0];

      let proposalText = `EXECUTIVE B2B PROPOSAL for ${lead.company_name || lead.lead_name}\n\nWe are pleased to offer SmartERP Enterprise License for ₹${Number(lead.deal_value).toLocaleString()}.\nIncluded: Multi-tenant ERP, Payroll, AI Agents & Priority Support.`;

      try {
        const provider = ProviderFactory.getProvider();
        const prompt = `Write a compelling, formal 3-paragraph B2B sales proposal for client "${lead.company_name || lead.lead_name}" (${lead.email}) for an enterprise software deal valued at ₹${lead.deal_value}.\nHighlight 3 core benefits: 1) AI Automation, 2) Zero Compliance Errors, 3) 24/7 Operations.`.trim();

        const completion = await provider.generateCompletion({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
        });

        if (completion.content) proposalText = completion.content.trim();
      } catch (err) {
        // Fallback proposal
      }

      // Save proposal text to lead record without modifying stage
      const updatedLead = await client.query(
        `UPDATE crm_leads_enhanced
         SET ai_proposal_text = $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [proposalText, leadId, companyId]
      );

      await client.query(
        `INSERT INTO crm_lead_activities (lead_id, company_id, created_by, activity_type, notes)
         VALUES ($1, $2, $3, 'proposal_generated', 'Generated Groq AI B2B Sales Proposal draft.')`,
        [leadId, companyId, userId]
      );

      await client.query('COMMIT');
      return updatedLead.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = CrmSalesService;
