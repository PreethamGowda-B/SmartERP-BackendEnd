const { pool } = require('../db');
const { createNotification, createCustomerPortalNotification, createNotificationForOwners, createNotificationForCompany, broadcastToUser } = require('../utils/notificationHelpers');
const AttendancePolicy = require('./attendancePolicyService');

/**
 * Enterprise Notification Routing Service
 * Centralizes notification routing rules, recipient resolution,
 * multi-tenant security, and deduplication across all SmartERP portals.
 */

const NOTIFICATION_EVENTS = {
  // Attendance
  ATTENDANCE_REMINDER: 'attendance_reminder',
  ATTENDANCE_EXCEPTION: 'attendance_exception',
  ATTENDANCE_AUTO_CLOCKED_OUT: 'attendance_auto_clocked_out',

  // Jobs
  JOB_ASSIGNED: 'job_assigned',
  JOB_ACCEPTED: 'job_accepted',
  JOB_DECLINED: 'job_declined',
  JOB_PROGRESS: 'job_progress',
  JOB_COMPLETED: 'job_completed',

  // Customer portal
  CUSTOMER_JOB_CREATED: 'customer_job_created',
  CUSTOMER_JOB_ACCEPTED: 'customer_job_accepted',
  CUSTOMER_JOB_COMPLETED: 'customer_job_completed',
  CUSTOMER_MESSAGE: 'customer_message',

  // Inventory & Supplies
  INVENTORY_ADDED: 'inventory_added',
  INVENTORY_LOW_STOCK: 'inventory_low_stock',
  MATERIAL_REQUEST_SUBMITTED: 'material_request_submitted',
  MATERIAL_REQUEST_APPROVED: 'material_request_approved',
  MATERIAL_REQUEST_REJECTED: 'material_request_rejected',

  // Finance & Invoices
  INVOICE_CREATED: 'invoice_created',
  INVOICE_ISSUED: 'invoice_issued',
  PAYMENT_RECEIVED: 'payment_received',
  PAYMENT_OVERDUE: 'payment_overdue',

  // HR & Payroll
  LEAVE_REQUEST_SUBMITTED: 'leave_request_submitted',
  LEAVE_REQUEST_APPROVED: 'leave_request_approved',
  LEAVE_REQUEST_REJECTED: 'leave_request_rejected',
  PAYROLL_PROCESSED: 'payroll_processed',

  // Platform & Superadmin
  SUPERADMIN_SECURITY_ALERT: 'superadmin_security_alert',
  SUPERADMIN_SUBSCRIPTION_UPDATE: 'superadmin_subscription_update'
};

class NotificationRoutingService {
  /**
   * Determine target portal URL based on user role and notification event
   */
  static resolvePortalUrl(role, event, data = {}) {
    const r = (role || '').toLowerCase();
    switch (r) {
      case 'employee':
        if (event.includes('attendance') || event.includes('clock')) return '/employee/time';
        if (event.includes('job')) return '/employee/jobs';
        if (event.includes('material')) return '/employee/materials';
        if (event.includes('payroll')) return '/employee/payroll';
        if (event.includes('leave')) return '/employee/hr-hub';
        return '/employee/notifications';

      case 'hr':
        if (event.includes('attendance')) return '/hr/attendance';
        if (event.includes('leave')) return '/hr/requests';
        if (event.includes('payroll')) return '/hr/payroll';
        if (event.includes('employee')) return '/hr/employees';
        return '/hr/notifications';

      case 'customer':
        if (event.includes('invoice') || event.includes('payment')) return '/customer/invoices';
        if (event.includes('job')) return '/customer/jobs';
        if (event.includes('chat') || event.includes('message')) return '/customer/chat';
        return '/customer/dashboard';

      case 'super_admin':
        if (event.includes('security')) return '/superadmin/security';
        if (event.includes('company') || event.includes('subscription')) return '/superadmin/companies';
        return '/superadmin';

      case 'owner':
      case 'admin':
      default:
        if (event.includes('attendance')) return '/owner/attendance';
        if (event.includes('customer_job')) return '/owner/customer-jobs';
        if (event.includes('job')) return '/owner/jobs';
        if (event.includes('material')) return '/owner/materials';
        if (event.includes('inventory')) return '/owner/inventory';
        if (event.includes('invoice') || event.includes('payment')) return '/owner/finance/invoices';
        if (event.includes('payroll')) return '/owner/payroll';
        if (event.includes('leave') || event.includes('hr')) return '/owner/hr-hub';
        return '/owner/notifications';
    }
  }

  /**
   * Route an attendance reminder to an employee.
   * STRICT RULES:
   * 1. Only employees receive missing-attendance reminders (owners/admins never receive this).
   * 2. Employees who have already clocked in today are skipped.
   * 3. Idempotency key guarantees at most 1 reminder per employee per date.
   */
  static async sendAttendanceReminder({ employeeId, companyId, dateStr = null }) {
    if (!employeeId || !companyId) return null;

    // Use current IST date if dateStr not supplied
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const targetDate = dateStr || AttendancePolicy.localDate(new Date(), policy.timezone);

    // Check 1: Verify employee role
    const userRes = await pool.query(
      `SELECT id, role, name, company_id FROM users WHERE id::text = $1::text`,
      [String(employeeId)]
    );
    const user = userRes.rows[0];
    if (!user || user.role !== 'employee' || String(user.company_id) !== String(companyId)) {
      console.log(`🔕 Skipped attendance reminder: User ${employeeId} is role=${user?.role}, not employee.`);
      return null;
    }

    // Check 2: Has employee already clocked in today?
    const attCheck = await pool.query(
      `SELECT id, check_in_time FROM attendance 
       WHERE user_id::text = $1::text AND company_id::text = $3::text AND date = $2 AND check_in_time IS NOT NULL
       LIMIT 1`,
      [String(employeeId), targetDate, String(companyId)]
    );
    if (attCheck.rows.length > 0) {
      console.log(`🔕 Skipped attendance reminder: Employee ${employeeId} already clocked in on ${targetDate}.`);
      return null;
    }

    const idempotencyKey = `att_rem:${employeeId}:${targetDate}`;

    return await createNotification({
      user_id: employeeId,
      company_id: companyId,
      type: NOTIFICATION_EVENTS.ATTENDANCE_REMINDER,
      title: '⏰ Attendance Reminder',
      message: "You haven't marked your attendance today. Please clock in for your shift.",
      priority: 'high',
      data: { url: '/employee/time', date: targetDate },
      idempotency_key: idempotencyKey
    });
  }

  /**
   * Run daily attendance check for all employees in a company who haven't clocked in
   * during morning work hours (e.g. 9:00 - 10:30 AM IST).
   * NEVER notifies owners.
   */
  static async dispatchDailyAttendanceReminders({ companyId = null, targetDate = null } = {}) {
    const policy = companyId ? await AttendancePolicy.getCompanyPolicy(companyId, pool) : AttendancePolicy.DEFAULT_ATTENDANCE_POLICY;
    const today = targetDate || AttendancePolicy.localDate(new Date(), policy.timezone);

    let query = `
      SELECT u.id, u.company_id, u.name 
      FROM users u
      WHERE u.role = 'employee'
        AND u.company_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM attendance a
          WHERE a.user_id::text = u.id::text AND a.company_id::text = u.company_id::text
            AND a.date = $1 
            AND a.check_in_time IS NOT NULL
        )
    `;
    const params = [today];
    if (companyId) {
      query += ` AND u.company_id::text = $2::text`;
      params.push(String(companyId));
    }

    const pendingEmployees = await pool.query(query, params);
    let sentCount = 0;

    for (const emp of pendingEmployees.rows) {
      const res = await this.sendAttendanceReminder({
        employeeId: emp.id,
        companyId: emp.company_id,
        dateStr: today
      });
      if (res) sentCount++;
    }

    console.log(`✅ Dispatched attendance reminders: ${sentCount} employees notified for ${today}`);
    return { notifiedCount: sentCount, totalPending: pendingEmployees.rows.length };
  }

  /**
   * Route job assignment notification to specific employee
   */
  static async routeJobAssigned({ jobId, employeeId, companyId, jobTitle, actorId = null }) {
    if (!employeeId || !companyId) return null;

    const idempotencyKey = `job_assign:${jobId}:${employeeId}`;
    return await createNotification({
      user_id: employeeId,
      company_id: companyId,
      type: NOTIFICATION_EVENTS.JOB_ASSIGNED,
      title: '📋 New Job Assigned',
      message: `You have been assigned to: ${jobTitle || 'New Job'}`,
      priority: 'high',
      actor_id: actorId,
      data: { job_id: jobId, url: '/employee/jobs' },
      idempotency_key: idempotencyKey
    });
  }

  /**
   * Route job lifecycle events (accepted, completed, declined) to Owner/Admin
   */
  static async routeJobStatusToOwners({ jobId, companyId, jobTitle, status, employeeName, actorId = null }) {
    if (!companyId) return null;

    let title = 'Job Update';
    let message = `${employeeName || 'A technician'} updated job: ${jobTitle}`;
    let type = NOTIFICATION_EVENTS.JOB_PROGRESS;

    if (status === 'accepted') {
      title = '✅ Job Accepted';
      message = `${employeeName || 'Technician'} accepted job: ${jobTitle}`;
      type = NOTIFICATION_EVENTS.JOB_ACCEPTED;
    } else if (status === 'completed') {
      title = '🎉 Job Completed';
      message = `${employeeName || 'Technician'} completed job: ${jobTitle}`;
      type = NOTIFICATION_EVENTS.JOB_COMPLETED;
    } else if (status === 'declined') {
      title = '⚠️ Job Declined';
      message = `${employeeName || 'Technician'} declined job: ${jobTitle}`;
      type = NOTIFICATION_EVENTS.JOB_DECLINED;
    }

    const idempotencyKey = `job_owner_${status}:${jobId}`;

    return await createNotificationForOwners({
      company_id: companyId,
      type,
      title,
      message,
      priority: status === 'completed' ? 'high' : 'medium',
      data: { job_id: jobId, url: '/owner/jobs' },
      exclude_user_id: actorId,
      idempotency_key: idempotencyKey
    });
  }

  /**
   * Route customer-specific job and billing updates.
   * Strictly enforces customer ownership.
   */
  static async routeCustomerNotification({ customerUserId, companyId, type, title, message, data = {}, idempotencyKey = null }) {
    if (!customerUserId || !companyId) return null;

    const url = this.resolvePortalUrl('customer', type, data);
    return await createCustomerPortalNotification({
      customerId: customerUserId,
      companyId,
      type,
      title,
      message,
      jobId: data.job_id || data.jobId,
      invoiceId: data.invoice_id || data.invoiceId || null,
      url,
    });
  }

  /**
   * Route material and inventory notifications
   */
  static async routeMaterialRequest({ requestId, companyId, employeeName, itemName, quantity, actorId = null }) {
    if (!companyId) return null;

    return await createNotificationForOwners({
      company_id: companyId,
      type: NOTIFICATION_EVENTS.MATERIAL_REQUEST_SUBMITTED,
      title: '📦 Material Request Submitted',
      message: `${employeeName || 'An employee'} requested ${quantity}x ${itemName}`,
      priority: 'medium',
      data: { request_id: requestId, url: '/owner/materials' },
      exclude_user_id: actorId,
      idempotency_key: `mat_req:${requestId}`
    });
  }

  /**
   * Route material request decision back to requesting employee
   */
  static async routeMaterialDecision({ requestId, employeeId, companyId, itemName, status, actorId = null }) {
    if (!employeeId || !companyId) return null;

    const approved = status === 'approved' || status === 'accepted';
    return await createNotification({
      user_id: employeeId,
      company_id: companyId,
      type: approved ? NOTIFICATION_EVENTS.MATERIAL_REQUEST_APPROVED : NOTIFICATION_EVENTS.MATERIAL_REQUEST_REJECTED,
      title: approved ? '✅ Material Request Approved' : '❌ Material Request Declined',
      message: `Your request for ${itemName} was ${approved ? 'approved' : 'declined'}.`,
      priority: 'high',
      actor_id: actorId,
      data: { request_id: requestId, url: '/employee/materials' },
      idempotency_key: `mat_dec:${requestId}:${status}`
    });
  }

  /**
   * Route system-level security or subscription alerts to Super Admin ONLY
   */
  static async routeSuperAdminAlert({ title, message, priority = 'high', data = {} }) {
    const superAdmins = await pool.query(
      `SELECT id FROM users WHERE role = 'super_admin'`
    );

    for (const sa of superAdmins.rows) {
      await createNotification({
        user_id: sa.id,
        company_id: null,
        type: NOTIFICATION_EVENTS.SUPERADMIN_SECURITY_ALERT,
        title,
        message,
        priority,
        data: { ...data, url: '/superadmin' }
      });
    }
  }
}

NotificationRoutingService.NOTIFICATION_EVENTS = NOTIFICATION_EVENTS;

module.exports = NotificationRoutingService;
module.exports.NotificationRoutingService = NotificationRoutingService;
module.exports.NOTIFICATION_EVENTS = NOTIFICATION_EVENTS;
