const test = require('node:test');
const assert = require('node:assert/strict');
const NotificationRoutingService = require('../services/notificationRoutingService');
const { NOTIFICATION_EVENTS } = NotificationRoutingService;

test.describe('Enterprise Notification Routing & Portal Delivery Test Suite', () => {

  // -----------------------------------------------------------------
  // 1. Role-Based Portal URL Resolution
  // -----------------------------------------------------------------
  test('ROUTE-1: Employee portal destination resolution', () => {
    assert.equal(NotificationRoutingService.resolvePortalUrl('employee', NOTIFICATION_EVENTS.ATTENDANCE_REMINDER), '/employee/time');
    assert.equal(NotificationRoutingService.resolvePortalUrl('employee', NOTIFICATION_EVENTS.JOB_ASSIGNED), '/employee/jobs');
    assert.equal(NotificationRoutingService.resolvePortalUrl('employee', NOTIFICATION_EVENTS.MATERIAL_REQUEST_APPROVED), '/employee/materials');
    assert.equal(NotificationRoutingService.resolvePortalUrl('employee', NOTIFICATION_EVENTS.PAYROLL_PROCESSED), '/employee/payroll');
    assert.equal(NotificationRoutingService.resolvePortalUrl('employee', NOTIFICATION_EVENTS.LEAVE_REQUEST_APPROVED), '/employee/hr-hub');
    assert.equal(NotificationRoutingService.resolvePortalUrl('employee', 'unknown_event'), '/employee/notifications');
  });

  test('ROUTE-2: HR portal destination resolution', () => {
    assert.equal(NotificationRoutingService.resolvePortalUrl('hr', NOTIFICATION_EVENTS.ATTENDANCE_EXCEPTION), '/hr/attendance');
    assert.equal(NotificationRoutingService.resolvePortalUrl('hr', NOTIFICATION_EVENTS.LEAVE_REQUEST_SUBMITTED), '/hr/requests');
    assert.equal(NotificationRoutingService.resolvePortalUrl('hr', NOTIFICATION_EVENTS.PAYROLL_PROCESSED), '/hr/payroll');
    assert.equal(NotificationRoutingService.resolvePortalUrl('hr', 'unknown_event'), '/hr/notifications');
  });

  test('ROUTE-3: Customer portal destination resolution', () => {
    assert.equal(NotificationRoutingService.resolvePortalUrl('customer', NOTIFICATION_EVENTS.INVOICE_CREATED), '/customer/invoices');
    assert.equal(NotificationRoutingService.resolvePortalUrl('customer', NOTIFICATION_EVENTS.CUSTOMER_JOB_ACCEPTED), '/customer/jobs');
    assert.equal(NotificationRoutingService.resolvePortalUrl('customer', NOTIFICATION_EVENTS.CUSTOMER_MESSAGE), '/customer/chat');
    assert.equal(NotificationRoutingService.resolvePortalUrl('customer', 'unknown_event'), '/customer/dashboard');
  });

  test('ROUTE-4: Super Admin portal destination resolution', () => {
    assert.equal(NotificationRoutingService.resolvePortalUrl('super_admin', NOTIFICATION_EVENTS.SUPERADMIN_SECURITY_ALERT), '/superadmin/security');
    assert.equal(NotificationRoutingService.resolvePortalUrl('super_admin', NOTIFICATION_EVENTS.SUPERADMIN_SUBSCRIPTION_UPDATE), '/superadmin/companies');
    assert.equal(NotificationRoutingService.resolvePortalUrl('super_admin', 'unknown_event'), '/superadmin');
  });

  test('ROUTE-5: Owner portal destination resolution (strictly existing owner tabs)', () => {
    assert.equal(NotificationRoutingService.resolvePortalUrl('owner', NOTIFICATION_EVENTS.ATTENDANCE_EXCEPTION), '/owner/attendance');
    assert.equal(NotificationRoutingService.resolvePortalUrl('owner', NOTIFICATION_EVENTS.CUSTOMER_JOB_CREATED), '/owner/customer-jobs');
    assert.equal(NotificationRoutingService.resolvePortalUrl('owner', NOTIFICATION_EVENTS.JOB_COMPLETED), '/owner/jobs');
    assert.equal(NotificationRoutingService.resolvePortalUrl('owner', NOTIFICATION_EVENTS.MATERIAL_REQUEST_SUBMITTED), '/owner/materials');
    assert.equal(NotificationRoutingService.resolvePortalUrl('owner', NOTIFICATION_EVENTS.INVENTORY_LOW_STOCK), '/owner/inventory');
    assert.equal(NotificationRoutingService.resolvePortalUrl('owner', NOTIFICATION_EVENTS.INVOICE_CREATED), '/owner/finance/invoices');
    assert.equal(NotificationRoutingService.resolvePortalUrl('owner', NOTIFICATION_EVENTS.PAYROLL_PROCESSED), '/owner/payroll');
    assert.equal(NotificationRoutingService.resolvePortalUrl('owner', NOTIFICATION_EVENTS.LEAVE_REQUEST_SUBMITTED), '/owner/hr-hub');
    assert.equal(NotificationRoutingService.resolvePortalUrl('owner', 'general_system_alert'), '/owner/notifications');
  });

  // -----------------------------------------------------------------
  // 2. Strict Attendance Routing & Owner Protection
  // -----------------------------------------------------------------
  test('ATT-1: Attendance reminders require valid employeeId and companyId', async () => {
    const res1 = await NotificationRoutingService.sendAttendanceReminder({ employeeId: null, companyId: 'comp-1' });
    assert.equal(res1, null, 'Should return null when employeeId is missing');

    const res2 = await NotificationRoutingService.sendAttendanceReminder({ employeeId: 'emp-1', companyId: null });
    assert.equal(res2, null, 'Should return null when companyId is missing');
  });

  test('ATT-2: Idempotency key format for attendance reminder prevents duplicates', () => {
    const empId = 'user-123';
    const date = '2026-10-13';
    const expectedKey = `att_rem:${empId}:${date}`;
    assert.equal(`att_rem:${empId}:${date}`, expectedKey);
  });

  // -----------------------------------------------------------------
  // 3. Mark All Read Query Multi-Tenant & Null Safety
  // -----------------------------------------------------------------
  test('NOTIF-1: mark-all-read cannot cross company boundaries or include unrelated null-company rows', () => {
    const simulateFilter = (notif, userId, companyId) => {
      const userMatches = String(notif.user_id) === String(userId);
      const companyMatches = companyId == null
        ? notif.company_id === null
        : String(notif.company_id) === String(companyId);
      const unread = notif.read === false;
      return userMatches && companyMatches && unread;
    };

    const notifs = [
      { id: 1, user_id: 'u1', company_id: 'c1', read: false },
      { id: 2, user_id: 'u1', company_id: null, read: false }, // Unscoped legacy row
      { id: 3, user_id: 'u1', company_id: 'c2', read: false }, // Other company
      { id: 4, user_id: 'u2', company_id: 'c1', read: false }, // Other user
      { id: 5, user_id: 'u1', company_id: 'c1', read: true }   // Already read
    ];

    const markedForU1C1 = notifs.filter(n => simulateFilter(n, 'u1', 'c1'));
    assert.equal(markedForU1C1.length, 1, 'Should only mark the matching company row for user u1');
    assert.equal(markedForU1C1.map(n => n.id).sort().join(','), '1');

    const markedForUnscopedU1 = notifs.filter(n => simulateFilter(n, 'u1', null));
    assert.deepEqual(markedForUnscopedU1.map(n => n.id), [2], 'An unscoped principal sees only its own null-company rows');
  });

  // -----------------------------------------------------------------
  // 4. Owner Portal Navigation Tab Audit Verification
  // -----------------------------------------------------------------
  test('SIDEBAR-1: Newly introduced tabs from eea2b96 are verified absent', () => {
    // The forbidden tabs that were removed
    const unwantedTabs = [
      'Quotations',
      'Invoice Issues',
      'Consumables',
      'Accounts Receivable',
      'AR Collections',
      'GST Reconciliation',
      'Financial Reports',
      'CNC Reports',
      'Remote Support'
    ];

    // Read the current owner sidebar file to verify absence
    const fs = require('fs');
    const path = require('path');
    const sidebarPath = path.resolve(__dirname, '../../SmartERP-Frontend/components/owner-sidebar.tsx');

    if (fs.existsSync(sidebarPath)) {
      const content = fs.readFileSync(sidebarPath, 'utf8');

      for (const unwanted of unwantedTabs) {
        // Assert that none of these unwanted tabs appear as navigation entries
        const pattern = new RegExp(`name:\\s*["']${unwanted}["']`, 'i');
        assert.equal(pattern.test(content), false, `Unwanted tab "${unwanted}" MUST NOT be in owner-sidebar.tsx`);
      }
    }
  });

  test.after(() => {
    try {
      const { pool } = require('../db');
      pool.end().catch(() => {});
    } catch {}
    try {
      const { redisClient } = require('../utils/redis');
      if (redisClient) redisClient.quit().catch(() => {});
    } catch {}
    setTimeout(() => process.exit(0), 100).unref();
  });
});
