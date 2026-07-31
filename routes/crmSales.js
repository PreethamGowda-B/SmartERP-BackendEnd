const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { checkPermission } = require('../middleware/rbac');
const CrmSalesService = require('../services/crmSalesService');

router.use(authenticateToken);

/**
 * GET /api/v1/crm-sales/pipeline
 * Fetches CRM leads grouped by Kanban pipeline stages.
 */
router.get('/pipeline', checkPermission('crm:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const summary = await CrmSalesService.getPipelineSummary(companyId);
    return res.json(summary);
  } catch (err) {
    console.error('Error fetching CRM pipeline:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve CRM sales pipeline.' });
  }
});

/**
 * POST /api/v1/crm-sales/leads
 * Ingests a new CRM lead and computes predictive lead score.
 */
router.post('/leads', checkPermission('crm:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const userId = req.user.userId;
    const { leadName, companyName, email, phone, dealValue, stage } = req.body;

    if (!leadName || !email) {
      return res.status(400).json({ error: 'Lead Name and Email are required.' });
    }

    const lead = await CrmSalesService.createLead({
      companyId,
      userId,
      leadName,
      companyName,
      email,
      phone,
      dealValue,
      stage,
    });

    return res.status(201).json({ success: true, lead });
  } catch (err) {
    console.error('Error creating lead:', err.message);
    return res.status(500).json({ error: 'Failed to create lead.' });
  }
});

/**
 * PATCH /api/v1/crm-sales/leads/:id/stage
 * Updates pipeline stage for a lead.
 */
router.patch('/leads/:id/stage', checkPermission('crm:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const userId = req.user.userId;
    const { id } = req.params;
    const { stage } = req.body;

    if (!stage) {
      return res.status(400).json({ error: 'Target stage is required.' });
    }

    const updatedLead = await CrmSalesService.updateLeadStage({
      companyId,
      userId,
      leadId: id,
      newStage: stage,
    });

    return res.json({ success: true, lead: updatedLead });
  } catch (err) {
    console.error('Error updating lead stage:', err.message);
    return res.status(500).json({ error: 'Failed to update lead stage.' });
  }
});

/**
 * POST /api/v1/crm-sales/leads/:id/generate-proposal
 * Generates a Groq AI B2B Sales Proposal for a lead.
 */
router.post('/leads/:id/generate-proposal', checkPermission('crm:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const userId = req.user.userId;
    const { id } = req.params;

    const updatedLead = await CrmSalesService.generateAiProposal({
      companyId,
      userId,
      leadId: id,
    });

    return res.json({
      success: true,
      message: 'Groq AI B2B Sales Proposal generated and stage set to PROPOSAL SENT.',
      lead: updatedLead,
    });
  } catch (err) {
    console.error('Error generating AI proposal:', err.message);
    return res.status(500).json({ error: 'Failed to generate AI proposal.' });
  }
});

module.exports = router;
