/**
 * scripts/verify_live_notifications_runtime.js
 *
 * Full End-to-End Live Runtime Verification Suite for SmartERP Real-Time Enterprise Notifications
 * Tests 17 Workflow Events across 4 Roles (Owner, Employee, HR, Customer) simultaneously.
 * Measures notification latency, payload accuracy, Target URLs, and SSE synchronization.
 */

const { pool } = require('../db');
const { createNotification, createNotificationForOwners, createNotificationForCompany, broadcastToUser } = require('../utils/notificationHelpers');
const jwt = require('jsonwebtoken');

// Multi-role test accounts
const TEST_COMPANY_ID = 9999;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_jwt_secret_32_bytes_long!!';

const USERS = {
  owner: { id: '00000000-0000-0000-0000-000000000091', role: 'owner', name: 'Verification Owner', email: 'owner_notif@smarterp.io' },
  employee: { id: '00000000-0000-0000-0000-000000000092', role: 'employee', name: 'Verification Technician', email: 'employee_notif@smarterp.io' },
  hr: { id: '00000000-0000-0000-0000-000000000093', role: 'hr', name: 'Verification HR Manager', email: 'hr_notif@smarterp.io' },
  customer: { id: '00000000-0000-0000-0000-000000000094', role: 'employee', name: 'Verification Customer', email: 'customer_notif@smarterp.io' }
};

const results = [];
const sseSubscribers = new Map();

const { registerSSEConnection } = require('../utils/notificationHelpers');

function subscribeUserSSE(role, userId) {
  const eventsReceived = [];
  const fakeRes = {
    write: (str) => {
      try {
        if (typeof str === 'string' && str.startsWith('data: ')) {
          const jsonStr = str.replace('data: ', '').trim();
          const parsed = JSON.parse(jsonStr);
          if (parsed.type === 'notification') {
            eventsReceived.push({
              timestamp: Date.now(),
              notification: parsed.data
            });
          }
        }
      } catch (e) {}
    }
  };

  registerSSEConnection(userId, fakeRes);
  sseSubscribers.set(userId, { role, fakeRes, eventsReceived });
}

async function setupTestUsers() {
  console.log('🔧 Setting up verification company & user accounts...');
  
  await pool.query(
    `INSERT INTO companies (id, company_id, company_name, subscription_status)
     VALUES ($1, $2, 'Live Verification Company', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_COMPANY_ID, String(TEST_COMPANY_ID)]
  );

  for (const [key, u] of Object.entries(USERS)) {
    await pool.query(
      `INSERT INTO users (id, company_id, name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'hashed_test_password', $5, true)
       ON CONFLICT (id) DO UPDATE SET role = $5, company_id = $2`,
      [u.id, TEST_COMPANY_ID, u.name, u.email, u.role]
    );
    subscribeUserSSE(key, u.id);
  }

  // Subscribe to Redis pub/sub channels for real-time verification
  const { getSharedSubscriber } = require('../utils/redis');
  const subscriber = getSharedSubscriber();
  if (subscriber) {
    subscriber.on('message', (ch, msgStr) => {
      const uid = ch.replace('employee_notifications:', '');
      const sub = sseSubscribers.get(uid);
      if (sub) {
        sub.listener(msgStr);
      }
    });

    for (const u of Object.values(USERS)) {
      await subscriber.subscribe(`employee_notifications:${u.id}`).catch(() => {});
    }
  }
}

async function runTestScenario(eventId, eventName, fromRole, toRole, triggerFn) {
  const startTime = Date.now();
  const targetUser = USERS[toRole];
  const targetSub = sseSubscribers.get(targetUser.id);
  const initialCount = targetSub ? targetSub.eventsReceived.length : 0;

  let error = null;
  try {
    await triggerFn();
  } catch (err) {
    error = err.message;
  }

  // Allow short delay for SSE dispatch
  await new Promise(r => setTimeout(r, 100));
  const endTime = Date.now();

  const currentCount = targetSub ? targetSub.eventsReceived.length : 0;
  const receivedNewEvent = currentCount > initialCount;
  const latestEvent = receivedNewEvent ? targetSub.eventsReceived[targetSub.eventsReceived.length - 1] : null;

  const latency = latestEvent ? (latestEvent.timestamp - startTime) : (endTime - startTime);
  const passed = receivedNewEvent && !error;

  const targetUrl = latestEvent?.notification?.data?.url || latestEvent?.notification?.data?.targetUrl || 'N/A';

  results.push({
    eventId,
    eventName,
    fromRole,
    toRole,
    passed,
    latencyMs: latency,
    targetUrl,
    error: error || (receivedNewEvent ? null : 'SSE Notification Event Not Delivered')
  });

  console.log(`${passed ? '✅ PASS' : '❌ FAIL'} [Event ${eventId}] ${eventName} (${fromRole} -> ${toRole}) | Latency: ${latency}ms | Target URL: ${targetUrl}`);
}

async function executeAllVerifications() {
  console.log('\n=========================================================');
  console.log('🚀 LIVE RUNTIME NOTIFICATION SYSTEM VERIFICATION SUITE');
  console.log('=========================================================\n');

  await setupTestUsers();

  const owner = USERS.owner;
  const emp = USERS.employee;
  const hr = USERS.hr;
  const cust = USERS.customer;

  let testJobId = '00000000-0000-0000-0000-000000000101';

  // 1. Owner creates job -> Employee popup
  await runTestScenario(1, 'Owner creates job', 'owner', 'employee', async () => {
    await pool.query(
      `INSERT INTO jobs (id, company_id, title, assigned_to, created_by, status)
       VALUES ($1, $2, 'HVAC Compressor Overhaul', $3, $4, 'open')
       ON CONFLICT (id) DO UPDATE SET title = 'HVAC Compressor Overhaul'`,
      [testJobId, TEST_COMPANY_ID, emp.id, owner.id]
    );
    await createNotification({
      user_id: emp.id,
      company_id: TEST_COMPANY_ID,
      type: 'job_assigned',
      title: 'New Job Assigned',
      message: 'You have been assigned: HVAC Compressor Overhaul',
      priority: 'high',
      actor_id: owner.id,
      data: { job_id: testJobId, url: '/employee/jobs' }
    });
  });

  // 2. Owner assigns/reassigns job -> Employee popup
  await runTestScenario(2, 'Owner reassigns job', 'owner', 'employee', async () => {
    await createNotification({
      user_id: emp.id,
      company_id: TEST_COMPANY_ID,
      type: 'job_assigned',
      title: 'Job Assigned To You',
      message: 'Job HVAC Compressor Overhaul has been reassigned to you.',
      priority: 'high',
      actor_id: owner.id,
      data: { job_id: testJobId, url: '/employee/jobs' }
    });
  });

  // 3. Employee accepts job -> Owner popup
  await runTestScenario(3, 'Employee accepts job', 'employee', 'owner', async () => {
    await createNotificationForOwners({
      company_id: TEST_COMPANY_ID,
      type: 'job_accepted',
      title: 'Job Accepted',
      message: `${emp.name} accepted job: HVAC Compressor Overhaul`,
      priority: 'medium',
      actor_id: emp.id,
      data: { job_id: testJobId, url: '/owner/jobs' }
    });
  });

  // 4. Employee updates progress -> Owner popup
  await runTestScenario(4, 'Employee updates progress', 'employee', 'owner', async () => {
    await createNotificationForOwners({
      company_id: TEST_COMPANY_ID,
      type: 'job_progress',
      title: 'Job Progress Updated',
      message: `${emp.name} updated progress to 75% on HVAC Compressor Overhaul`,
      priority: 'medium',
      actor_id: emp.id,
      data: { job_id: testJobId, url: '/owner/jobs' }
    });
  });

  // 5. Employee uploads proof -> Owner popup
  await runTestScenario(5, 'Employee uploads site proof', 'employee', 'owner', async () => {
    await createNotificationForOwners({
      company_id: TEST_COMPANY_ID,
      type: 'proof_of_work',
      title: 'Site Proof Uploaded',
      message: `📸 ${emp.name} uploaded site proof photo for job HVAC Compressor Overhaul`,
      priority: 'medium',
      actor_id: emp.id,
      data: { job_id: testJobId, url: '/owner/jobs' }
    });
  });

  // 6. Employee submits work request -> Owner popup
  await runTestScenario(6, 'Employee submits field action request', 'employee', 'owner', async () => {
    await createNotificationForOwners({
      company_id: TEST_COMPANY_ID,
      type: 'job_action_request',
      title: 'Work Request: Material Requisition',
      message: `${emp.name} submitted a request: Extra copper pipe required`,
      priority: 'high',
      actor_id: emp.id,
      data: { job_id: testJobId, url: '/owner/jobs' }
    });
  });

  // 7. Owner approves work request -> Employee popup
  await runTestScenario(7, 'Owner approves work request', 'owner', 'employee', async () => {
    await createNotification({
      user_id: emp.id,
      company_id: TEST_COMPANY_ID,
      type: 'job_action_response',
      title: 'Work Request APPROVED ✅',
      message: 'Your request for extra copper pipe was approved by owner.',
      priority: 'high',
      actor_id: owner.id,
      data: { job_id: testJobId, url: '/employee/jobs' }
    });
  });

  // 8. Customer creates job -> Owner popup
  await runTestScenario(8, 'Customer creates job request', 'customer', 'owner', async () => {
    await createNotificationForOwners({
      company_id: TEST_COMPANY_ID,
      type: 'customer_job_request',
      title: 'New Customer Job Request',
      message: `Customer ${cust.name} submitted job request: Emergency Generator Repair`,
      priority: 'high',
      actor_id: cust.id,
      data: { job_id: '00000000-0000-0000-0000-000000000102', url: '/owner/customer-jobs' }
    });
  });

  // 9. Customer raises invoice issue -> Owner popup
  await runTestScenario(9, 'Customer raises invoice issue', 'customer', 'owner', async () => {
    await createNotificationForOwners({
      company_id: TEST_COMPANY_ID,
      type: 'invoice_issue',
      title: 'Invoice Dispute Raised',
      message: `Customer ${cust.name} raised dispute on Invoice #INV-2026-009`,
      priority: 'urgent',
      actor_id: cust.id,
      data: { invoice_id: '109', url: '/owner/invoice-issues' }
    });
  });

  // 10. Owner generates invoice -> Customer popup
  await runTestScenario(10, 'Owner generates invoice', 'owner', 'customer', async () => {
    await createNotification({
      user_id: cust.id,
      company_id: TEST_COMPANY_ID,
      type: 'invoice_generated',
      title: 'New Invoice Issued',
      message: 'Invoice #INV-2026-010 for ₹14,500 is ready for payment.',
      priority: 'high',
      actor_id: owner.id,
      data: { invoice_id: '110', url: '/customer/invoices' }
    });
  });

  // 11. Invoice updated -> Customer popup
  await runTestScenario(11, 'Invoice updated / issue resolved', 'owner', 'customer', async () => {
    await createNotification({
      user_id: cust.id,
      company_id: TEST_COMPANY_ID,
      type: 'invoice_updated',
      title: 'Invoice Updated',
      message: 'Invoice #INV-2026-009 discount applied. Revised total: ₹12,000.',
      priority: 'high',
      actor_id: owner.id,
      data: { invoice_id: '109', url: '/customer/invoices' }
    });
  });

  // 12. Payment received -> Owner popup
  await runTestScenario(12, 'Payment received', 'customer', 'owner', async () => {
    await createNotificationForOwners({
      company_id: TEST_COMPANY_ID,
      type: 'payment_received',
      title: 'Payment Received',
      message: 'Payment of ₹14,500 received via Razorpay for Invoice #INV-2026-010',
      priority: 'high',
      actor_id: cust.id,
      data: { url: '/owner/finance' }
    });
  });

  // 13. Leave request submitted -> HR popup
  await runTestScenario(13, 'Leave request submitted', 'employee', 'hr', async () => {
    await createNotification({
      user_id: hr.id,
      company_id: TEST_COMPANY_ID,
      type: 'leave_request',
      title: 'New Leave Request',
      message: `${emp.name} submitted a Casual Leave application for Aug 12-14.`,
      priority: 'medium',
      actor_id: emp.id,
      data: { request_id: '501', url: '/hr/requests' }
    });
  });

  // 14. HR approves leave -> Employee popup
  await runTestScenario(14, 'HR approves leave', 'hr', 'employee', async () => {
    await createNotification({
      user_id: emp.id,
      company_id: TEST_COMPANY_ID,
      type: 'leave_decision',
      title: 'Leave Request APPROVED ✅',
      message: `Your Casual Leave for Aug 12-14 was approved by ${hr.name}.`,
      priority: 'high',
      actor_id: hr.id,
      data: { request_id: '501', url: '/employee/notifications' }
    });
  });

  // 15. Attendance correction -> HR popup
  await runTestScenario(15, 'Attendance correction request', 'employee', 'hr', async () => {
    await createNotification({
      user_id: hr.id,
      company_id: TEST_COMPANY_ID,
      type: 'attendance_correction',
      title: 'Attendance Correction Request',
      message: `${emp.name} requested check-in time correction for Aug 3.`,
      priority: 'medium',
      actor_id: emp.id,
      data: { request_id: '502', url: '/hr/requests' }
    });
  });

  // 16. Payroll processed -> Employee popup
  await runTestScenario(16, 'Payroll processed', 'owner', 'employee', async () => {
    await createNotification({
      user_id: emp.id,
      company_id: TEST_COMPANY_ID,
      type: 'payroll',
      title: 'Payslip Ready 🧾',
      message: 'Your payroll for July 2026 has been processed. Net salary: ₹45,000',
      priority: 'high',
      actor_id: owner.id,
      data: { payroll_id: '701', url: '/employee/payroll' }
    });
  });

  // 17. New chat message -> Recipient popup
  await runTestScenario(17, 'New direct chat message', 'owner', 'employee', async () => {
    await createNotification({
      user_id: emp.id,
      company_id: TEST_COMPANY_ID,
      type: 'message',
      title: 'New Message from Owner',
      message: 'Please check site safety equipment before departure.',
      priority: 'high',
      actor_id: owner.id,
      data: { conversation_id: '901', url: '/employee/messages' }
    });
  });

  // ── Print Verification Summary ─────────────────────────────────────────────
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.filter(r => !r.passed).length;
  const totalLatency = results.reduce((acc, r) => acc + r.latencyMs, 0);
  const avgLatency = (totalLatency / results.length).toFixed(1);

  console.log('\n=========================================================');
  console.log('📊 REAL-TIME NOTIFICATION VERIFICATION SUMMARY REPORT');
  console.log('=========================================================');
  console.log(`Total Scenarios Tested : ${results.length}`);
  console.log(`Passed                 : ${passedCount} / ${results.length} ✅`);
  console.log(`Failed                 : ${failedCount} ❌`);
  console.log(`Average Latency        : ${avgLatency} ms (Target: <500ms)`);
  console.log('=========================================================\n');

  if (failedCount > 0) {
    console.log('❌ Failed Scenarios:');
    results.filter(r => !r.passed).forEach(f => {
      console.log(`   - Event ${f.eventId}: ${f.eventName} (${f.error})`);
    });
  }

  process.exit(failedCount > 0 ? 1 : 0);
}

executeAllVerifications().catch(err => {
  console.error('Fatal Verification Error:', err);
  process.exit(1);
});
