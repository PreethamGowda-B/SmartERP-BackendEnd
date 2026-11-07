const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');
const { requireFeature } = require('../middleware/featureGuard');
const { checkPlanLimit } = require('../middleware/planMiddleware');
const { createAiPromptGuard } = require('../middleware/aiPromptGuard');
const { getAiErrorResponse } = require('../utils/aiErrorResponse');
const { redisClient } = require('../utils/redis');
const { createApprovalToken, consumeApprovalToken } = require('../services/aiActionApproval');

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
    const role = req.user.role || 'employee';
    const prompt = req.sanitizedAiPrompt;
    const { mode = 'query', confirm_action = false } = req.body;

    if (!companyId) {
      return res.status(403).json({ message: 'Select a company context before using the company operations copilot.' });
    }

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
      if (!['owner', 'admin', 'hr', 'service_manager'].includes(String(role).toLowerCase())) {
        return res.status(403).json({ message: 'You are not authorized to view company-wide job information.' });
      }
      const jobsRes = await pool.query(
        `SELECT id, title, status, priority, service_type FROM jobs WHERE company_id::text = $1::text AND status NOT IN ('completed', 'cancelled')`,
        [companyId]
      );
      responseText = `Found ${jobsRes.rows.length} pending job(s) for your company: ${jobsRes.rows.map((j) => `"${j.title}" (${j.service_type})`).join(', ')}.`;
      workflowType = 'query_jobs';
    } else if (lower.includes('revenue') || lower.includes('financial')) {
      if (!['owner', 'admin'].includes(String(role).toLowerCase())) {
        return res.status(403).json({ message: 'Only owners and administrators may view company financial summaries.' });
      }
      const invRes = await pool.query(
        `SELECT SUM(total_amount) as total FROM service_quotations WHERE company_id::text = $1::text AND status = 'converted_to_job'`,
        [companyId]
      );
      responseText = `Total revenue recorded from approved CNC service jobs is ₹${Number(invRes.rows[0]?.total || 0).toLocaleString()}.`;
      workflowType = 'query_revenue';
    } else if (lower.includes('machine') && (lower.includes('breakdown') || lower.includes('health'))) {
      if (!['owner', 'admin', 'service_manager'].includes(String(role).toLowerCase())) {
        return res.status(403).json({ message: 'You are not authorized to view company-wide machine information.' });
      }
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

      if (!['owner', 'admin'].includes(String(role).toLowerCase())) {
        return res.status(403).json({ message: 'Only an owner or administrator may approve an AI-created service job.' });
      }

      const isPm = workflowType === 'pm_flow';
      const jobPayload = {
        title: isPm ? '[AI Scheduled PM] Machine Maintenance Visit' : '[AI Breakdown Dispatch] CNC Breakdown Repair',
        serviceType: isPm ? 'preventive' : 'breakdown',
        priority: 'high',
      };
      const approvalPayload = { workflowType, job: jobPayload };

      if (!confirm_action) {
        let approvalToken;
        try {
          approvalToken = createApprovalToken({
            userId,
            companyId,
            action: 'create_service_job',
            payload: approvalPayload,
          });
        } catch (approvalError) {
          const response = getAiErrorResponse(approvalError);
          return res.status(response.status).json({ ...response.body, message: response.body.error });
        }
        return res.json({
          success: true,
          execution_level: 2,
          requires_confirmation: true,
          approval_token: approvalToken,
          approval_expires_in_seconds: 300,
          workflow_type: workflowType,
          ai_interpretation: `Intended action: create one ${workflowType === 'pm_flow' ? 'preventive maintenance' : 'breakdown'} job and add a machine timeline event. No machine, customer, assignment, or notification is included.`,
          message: `Please confirm execution of this multi-step ${workflowType === 'pm_flow' ? 'PM' : 'Breakdown'} AI workflow.`,
        });
      }

      try {
        await consumeApprovalToken(req.body?.approval_token, {
          userId,
          companyId,
          action: 'create_service_job',
          payload: approvalPayload,
          redisClient,
        });
      } catch (approvalError) {
        const response = getAiErrorResponse(approvalError);
        return res.status(response.status).json({ ...response.body, message: response.body.error });
      }

      // Execute the approved workflow, timeline event, and audit record in one
      // tenant-scoped transaction. The AI cannot vary any write fields after approval.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_company_id', $1::text, true)", [String(companyId)]);
        const jobRes = await client.query(
          `INSERT INTO jobs (title, description, customer_id, company_id, service_type, priority, status, employee_status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'open', 'pending', NOW(), NOW())
           RETURNING id, title`,
          [jobPayload.title, `Workflow created by SmartERP AI Copilot for ${userName}.`, null, companyId, jobPayload.serviceType, jobPayload.priority]
        );
        const job = jobRes.rows[0];
        await client.query(
          `INSERT INTO machine_timeline_events (company_id, event_type, title, description, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [companyId, isPm ? 'pm_scheduled' : 'breakdown_reported', jobPayload.title, `AI Workflow initiated by ${userName}`]
        );
        await client.query(
          `INSERT INTO ai_action_audit_trail (company_id, user_id, user_name, prompt, ai_interpretation, workflow_type, execution_level, approval_status, result_summary, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 2, 'executed', $7, NOW())`,
          [companyId, userId, userName, `AI request (${workflowType})`, 'User approved a server-verified, payload-bound AI service job.', workflowType, `Created job ${job.id}`]
        );
        await client.query('COMMIT');
        actionResult = { job_id: job.id, job_title: job.title };
        responseText = `Created job #${String(job.id).substring(0, 8)}. Open the job record to review its current assignment and status.`;
      } catch (writeError) {
        await client.query('ROLLBACK').catch(() => {});
        throw writeError;
      } finally {
        client.release();
      }
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
    if (!companyId) {
      return res.status(403).json({ success: false, message: 'Select a company context before viewing AI activity.' });
    }
    if (!['owner', 'admin', 'hr', 'service_manager'].includes(String(req.user.role || '').toLowerCase())) {
      return res.status(403).json({ success: false, message: 'You are not authorized to view company AI activity.' });
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
