const { pool } = require('../db');
const { emitSystemEvent } = require('./eventBus');

/**
 * Evaluate active automation rules for a given event trigger.
 */
async function evaluateAutomationRules(triggerEvent, payload = {}) {
  const { companyId = 1, jobId, machineId, itemId, details = '' } = payload;

  try {
    const rulesRes = await pool.query(
      `SELECT * FROM automation_rules
       WHERE (company_id::text = $1::text OR company_id = $2)
         AND trigger_event = $3
         AND is_active = true`,
      [companyId.toString(), parseInt(companyId, 10) || 1, triggerEvent]
    );

    for (const rule of rulesRes.rows) {
      console.log(`⚡ [AUTOMATION ENGINE] Executing Rule: "${rule.rule_name}" (Action: ${rule.action_type})`);

      // Execute Action based on action_type
      if (rule.action_type === 'notify_owner' || rule.action_type === 'notify_manager') {
        await pool.query(
          `INSERT INTO notifications (company_id, title, message, type, created_at)
           VALUES ($1, $2, $3, 'automation', NOW())`,
          [companyId, `Automation Rule Triggered: ${rule.rule_name}`, details || `Automated action executed for ${triggerEvent}`]
        ).catch(() => {});
      } else if (rule.action_type === 'escalate_priority' && jobId) {
        await pool.query(
          `UPDATE jobs SET priority = 'urgent', updated_at = NOW() WHERE id::text = $1::text`,
          [jobId]
        ).catch(() => {});
      } else if (rule.action_type === 'auto_po' && itemId) {
        const poNum = `PO-AUTO-${Date.now().toString().slice(-6)}`;
        await pool.query(
          `INSERT INTO purchase_orders (company_id, po_number, parts_description, total_cost, status, created_at)
           VALUES ($1, $2, $3, 15000, 'issued', NOW())`,
          [companyId, poNum, `Auto-reorder for item ID ${itemId}`]
        ).catch(() => {});
      }

      // Log execution in audit trail
      await emitSystemEvent('AUTOMATION_EXECUTED', {
        companyId,
        action: `Automation Rule Executed: ${rule.rule_name}`,
        details: { triggerEvent, actionType: rule.action_type, jobId, machineId, itemId },
      });
    }
  } catch (err) {
    console.error('❌ Error evaluating automation rules:', err.message);
  }
}

module.exports = { evaluateAutomationRules };
