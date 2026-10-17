'use strict';

const INTERNAL_NOTIFICATION_ROLES = new Set(['owner', 'employee', 'hr', 'admin', 'super_admin']);

// This allowlist is intentionally narrow. Every accepted customer event must
// also pass the job/invoice ownership checks in the notification API/helper.
const CUSTOMER_NOTIFICATION_TYPES = new Set([
  'customer_job_created',
  'customer_job_received',
  'customer_job_accepted',
  'customer_job_status',
  'customer_job_completed',
  'job_approved',
  'job_rejected',
  'customer_appointment_updated',
  'invoice_issued',
  'invoice_updated',
  'payment_received',
  'payment_status_updated',
  'customer_message',
]);

function isInternalNotificationRole(role) {
  return INTERNAL_NOTIFICATION_ROLES.has(String(role || '').toLowerCase());
}

function isCustomerNotificationTypeAllowed(type) {
  return CUSTOMER_NOTIFICATION_TYPES.has(String(type || '').toLowerCase());
}

function isCustomerNotificationAuthorized(notification, principal) {
  if (!notification || !principal?.id || !principal?.companyId) return false;
  const details = typeof notification.details === 'string'
    ? (() => { try { return JSON.parse(notification.details); } catch { return null; } })()
    : notification.details;
  if (!details || String(details.customer_id || '') !== String(principal.id)) return false;
  if (String(notification.company_id || '') !== String(principal.companyId)) return false;
  return isCustomerNotificationTypeAllowed(details.type || notification.type);
}

module.exports = {
  INTERNAL_NOTIFICATION_ROLES,
  CUSTOMER_NOTIFICATION_TYPES,
  isInternalNotificationRole,
  isCustomerNotificationTypeAllowed,
  isCustomerNotificationAuthorized,
};
