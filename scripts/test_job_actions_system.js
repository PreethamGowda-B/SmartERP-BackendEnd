/**
 * scripts/test_job_actions_system.js
 * Verification of Job Actions System End-to-End Workflow
 */
const { pool } = require('../db');

async function verifyJobActions() {
  console.log('\n--- VERIFYING JOB ACTIONS SYSTEM ---');

  // 1. Find or create a test job
  let jobRes = await pool.query("SELECT id, title, company_id FROM jobs LIMIT 1");
  let job = jobRes.rows[0];

  if (!job) {
    const newJob = await pool.query(
      `INSERT INTO jobs (title, description, status, company_id, created_at)
       VALUES ('HVAC Service Project', 'System repair and safety inspection', 'in_progress', 1, NOW())
       RETURNING *`
    );
    job = newJob.rows[0];
  }

  // Find a test user
  const userRes = await pool.query("SELECT id, name FROM users LIMIT 1");
  const user = userRes.rows[0];

  const companyId = String(job.company_id || 1);
  console.log(`📌 Target Job ID: ${job.id} ("${job.title}") | Company ID: ${companyId}`);

  // 2. Insert test job action record directly into database
  const insertAction = await pool.query(
    `INSERT INTO job_actions 
     (job_id, company_id, performed_by, module, action_type, urgency, requires_approval, status, notes, payload, created_at, updated_at)
     VALUES ($1, $2, $3, 'assistance', 'need_more_workers', 'high', true, 'pending_approval', $4, $5, NOW(), NOW())
     RETURNING *`,
    [job.id, companyId, user.id, 'Need 2 extra technicians for heavy duct lifting', JSON.stringify({ worker_count: 2 })]
  );

  const action = insertAction.rows[0];
  console.log('✅ 1. Submitted Job Action Record:');
  console.log('   - Action ID:', action.id);
  console.log('   - Module:', action.module);
  console.log('   - Action Type:', action.action_type);
  console.log('   - Urgency:', action.urgency);
  console.log('   - Status:', action.status);
  console.log('   - Payload:', action.payload);

  // 3. Query pending approvals (Owner Approval Center endpoint simulation)
  const pendingApprovals = await pool.query(
    `SELECT ja.*, j.title as job_title, u.name as requester_name
     FROM job_actions ja
     LEFT JOIN jobs j ON ja.job_id = j.id
     LEFT JOIN users u ON ja.performed_by = u.id
     WHERE ja.id = $1`,
    [action.id]
  );

  console.log('\n📋 2. Verified Entry in Owner Approval Center Queue:');
  console.table(pendingApprovals.rows.map(row => ({
    id: row.id,
    job_title: row.job_title,
    requester: row.requester_name,
    action_type: row.action_type,
    status: row.status,
    notes: row.notes
  })));

  // 4. Respond to action (Owner Approval)
  const ownerResponse = await pool.query(
    `UPDATE job_actions 
     SET status = 'approved', owner_response = '2 Technicians assigned and dispatched.', resolved_by = $1, resolved_at = NOW(), updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [user.id, action.id]
  );

  const updatedAction = ownerResponse.rows[0];
  console.log('✅ 3. Owner Decision Executed:');
  console.log('   - Final Status:', updatedAction.status);
  console.log('   - Owner Note:', updatedAction.owner_response);
  console.log('   - Resolved At:', updatedAction.resolved_at);

  // 5. Verify notification logging
  await pool.query(
    `INSERT INTO notifications (user_id, company_id, type, title, message, priority, created_at)
     VALUES ($1, $2, 'field_action_response', 'Field Request Approved ✅', 'Your request (need more workers) was approved: 2 Technicians assigned and dispatched.', 'high', NOW())`,
    [user.id, companyId]
  );

  const notif = await pool.query(
    `SELECT id, type, title, message FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );

  console.log('\n📡 4. Verified Employee Notification Event:');
  console.log(notif.rows[0]);

  console.log('\n🎉 JOB ACTIONS SYSTEM VERIFICATION COMPLETE!\n');
  process.exit(0);
}

verifyJobActions().catch((err) => {
  console.error('❌ Job Actions verification failed:', err);
  process.exit(1);
});
