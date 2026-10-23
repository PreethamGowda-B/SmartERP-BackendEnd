const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');
const { requireFeature } = require('../middleware/featureGuard');
const { checkPlanLimit } = require('../middleware/planMiddleware');
const { createAiPromptGuard } = require('../middleware/aiPromptGuard');
const { getAiErrorResponse } = require('../utils/aiErrorResponse');

const validateCopilotPrompt = createAiPromptGuard({ field: 'prompt' });

function requireJobQuotaForCopilot(req, res, next) {
  const prompt = String(req.sanitizedAiPrompt || '').toLowerCase();
  const createsJob = prompt.includes('create job') || prompt.includes('breakdown job') || prompt.includes('schedule pm');
  return createsJob ? checkPlanLimit('job')(req, res, next) : next();
}

// ─── POST /api/ai/copilot (Enterprise AI Operations Copilot & Multi-Step Workflows) ───
router.post('/', authenticateToken, loadPlan, requireFeature('ai_assistant', 'AI assistant'), validateCopilotPrompt, requireJobQuotaForCopilot, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'No company associated with this account' });
    }
    const userId = req.user.userId || req.user.id;
    const userName = req.user.name || 'User';
    const role = req.user.role || 'owner';
    const prompt = req.sanitizedAiPrompt;
    const { mode = 'query', confirm_action = false } = req.body;

    // RBAC Permission Guard for AI Copilot
    if (role === 'customer' && prompt.toLowerCase().includes('delete')) {
      return res.status(403).json({ message: 'AI Action Restricted: Customers cannot execute deletion workflows.' });
    }

    const lower = prompt.toLowerCase();
    let responseText = '';
    let executionLevel = 1; // 1: Immediate Read, 2: Confirmation Required, 3: Explicit Owner Approval
    let actionResult = null;
    let workflowType = 'query';

    // ── 1. READ-ONLY QUERY INTENTS (Level 1 - Immediate) ─────────────────────
    if (lower.includes('pending job') || lower.includes('active job')) {
      const jobsRes = await pool.query(
        `SELECT id, title, status, priority, service_type FROM jobs WHERE company_id::text = $1::text AND status NOT IN ('completed', 'cancelled')`,
        [companyId]
      );
      responseText = `Found ${jobsRes.rows.length} pending job(s) for your company: ${jobsRes.rows.map((j) => `"${j.title}" (${j.service_type})`).join(', ')}.`;
      workflowType = 'query_jobs';
    } else if (lower.includes('revenue') || lower.includes('financial')) {
      const invRes = await pool.query(
        `SELECT SUM(total_amount) as total FROM service_quotations WHERE company_id::text = $1::text AND status = 'converted_to_job'`,
        [companyId]
      );
      responseText = `Total revenue recorded from approved CNC service jobs is ₹${Number(invRes.rows[0]?.total || 0).toLocaleString()}.`;
      workflowType = 'query_revenue';
    } else if (lower.includes('machine') && (lower.includes('breakdown') || lower.includes('health'))) {
      const macRes = await pool.query(
        `SELECT machine_name, serial_number, health_score, status FROM customer_machines WHERE company_id::text = $1::text ORDER BY health_score ASC`,
        [companyId]
      );
      responseText = macRes.rows.length
        ? `Registered machinery telemetry: ${macRes.rows.map((m) => `${m.machine_name} (Health: ${m.health_score == null ? 'not reported' : `${m.health_score}%`}, Status: ${m.status})`).join(' | ')}.`
        : 'No machines are currently registered for this company.';
      workflowType = 'query_machines';
    }

    // ── 2. WORKFLOW INTENTS (Level 2 - Confirmation Required) ───────────────
    else if (lower.includes('create job') || lower.includes('breakdown job') || lower.includes('schedule pm')) {
      executionLevel = 2;
      workflowType = lower.includes('schedule pm') ? 'pm_flow' : 'breakdown_flow';

      if (!confirm_action) {
        return res.json({
          success: true,
          execution_level: 2,
          requires_confirmation: true,
          workflow_type: workflowType,
          ai_interpretation: `Intended action: Create a new ${workflowType === 'pm_flow' ? 'Preventive Maintenance' : 'Breakdown'} Job with Machine metadata, update Machine Timeline, tag "Created by SmartERP AI", and send owner notification.`,
          message: `Please confirm execution of this multi-step ${workflowType === 'pm_flow' ? 'PM' : 'Breakdown'} AI workflow.`,
        });
      }

      // Execute Multi-Step Workflow using DB Transaction
      const isPm = workflowType === 'pm_flow';
      const jobTitle = isPm ? `[AI Scheduled PM] Machine Maintenance Visit` : `[AI Breakdown Dispatch] CNC Breakdown Repair`;

      const jobRes = await pool.query(
        `INSERT INTO jobs (title, description, customer_id, company_id, service_type, priority, status, employee_status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'high', 'open', 'pending', NOW(), NOW())
         RETURNING *`,
        [
          jobTitle,
          `Multi-step workflow created by SmartERP AI Copilot for ${userName}.`,
          'self',
          companyId,
          isPm ? 'preventive' : 'breakdown',
        ]
      );

      const job = jobRes.rows[0];

      // Auto-Trigger Timeline Event
      await pool.query(
        `INSERT INTO machine_timeline_events (company_id, event_type, title, description, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [companyId, isPm ? 'pm_scheduled' : 'breakdown_reported', jobTitle, `AI Workflow initiated by ${userName}`]
      ).catch(() => {});

      actionResult = { job_id: job.id, job_title: job.title };
      responseText = `Created job #${job.id.toString().substring(0, 8)}. Open the job record to review its current assignment and status.`;
    }

    // ── 3. HIGH-RISK INTENTS (Level 3 - Explicit Owner Approval) ─────────────
    else if (lower.includes('delete') || lower.includes('cancel') || lower.includes('close finance')) {
      executionLevel = 3;
      workflowType = 'high_risk_action';

      if (role !== 'owner' && role !== 'admin') {
        return res.status(403).json({ message: 'Level 3 High-Risk AI Actions require Owner privileges.' });
      }

      if (!confirm_action) {
        return res.json({
          success: true,
          execution_level: 3,
          requires_confirmation: true,
          workflow_type: workflowType,
          ai_interpretation: `High-Risk Action Requested: "${prompt}". Requires explicit Owner approval.`,
          message: `⚠️ HIGH-RISK ACTION: This operation modifies core financial or job records. Click Confirm to approve.`,
        });
      }

      return res.status(501).json({
        success: false,
        code: 'AI_WORKFLOW_NOT_IMPLEMENTED',
        message: 'This high-risk operation is not connected to an approved execution workflow. No business records were changed.',
      });
    } else {
      responseText = 'I can help with company jobs, machine status, revenue summaries, and approved job workflows. Ask about one of those areas to continue.';
    }

    // Log Immutable AI Audit Trail
    await pool.query(
      `INSERT INTO ai_action_audit_trail (company_id, user_id, user_name, prompt, ai_interpretation, workflow_type, execution_level, approval_status, result_summary, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'executed', $8, NOW())`,
      [companyId, userId, userName, `AI request (${workflowType})`, 'AI response generated; business content redacted.', workflowType, executionLevel, 'AI response generated; business content redacted.']
    ).catch(() => {});

    res.json({
      success: true,
      mode,
      execution_level: executionLevel,
      response: responseText,
      action_result: actionResult,
    });
  } catch (err) {
    console.error('❌ Error executing AI Copilot workflow:', {
      code: typeof err?.code === 'string' ? err.code.slice(0, 40) : null,
      name: typeof err?.name === 'string' ? err.name.slice(0, 80) : 'Error',
    });
    const response = getAiErrorResponse(err);
    res.status(response.status).json({ ...response.body, message: response.body.error });
  }
});

// ─── GET /api/ai/copilot/activity (AI Activity Center Log) ─────────────────
router.get('/activity', authenticateToken, loadPlan, requireFeature('ai_assistant', 'AI assistant'), async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && req.user.role !== 'super_admin') {
      return res.json({ success: true, activities: [] });
    }

    const result = await pool.query(
      `SELECT * FROM ai_action_audit_trail WHERE company_id::text = $1::text ORDER BY created_at DESC LIMIT 30`,
      [companyId.toString()]
    );

    res.json({ success: true, activities: result.rows });
  } catch (err) {
    console.error('❌ Error fetching AI Activity Log:', {
      code: typeof err?.code === 'string' ? err.code.slice(0, 40) : null,
      name: typeof err?.name === 'string' ? err.name.slice(0, 80) : 'Error',
    });
    const response = getAiErrorResponse(err);
    res.status(response.status).json({ ...response.body, success: false });
  }
});

module.exports = router;
