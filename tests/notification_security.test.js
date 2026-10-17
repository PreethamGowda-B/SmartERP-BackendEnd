'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isInternalNotificationRole,
  isCustomerNotificationTypeAllowed,
  isCustomerNotificationAuthorized,
} = require('../utils/notificationAudience');

const customerPrincipal = { id: 'customer-a', companyId: 'company-a' };

test('notification roles exclude customers and preserve supported staff roles', () => {
  for (const role of ['owner', 'employee', 'hr', 'admin', 'super_admin']) assert.equal(isInternalNotificationRole(role), true);
  for (const role of ['customer', 'Customer', 'anonymous', '']) assert.equal(isInternalNotificationRole(role), false);
});

test('customer notification allowlist blocks payroll, attendance, materials and internal messages', () => {
  for (const type of ['payroll_processed', 'salary_updated', 'attendance_exception', 'material_request_submitted', 'employee_message', 'inventory_added']) {
    assert.equal(isCustomerNotificationTypeAllowed(type), false, `${type} must remain internal`);
  }
  for (const type of ['customer_job_accepted', 'job_approved', 'invoice_issued', 'payment_received', 'customer_message']) {
    assert.equal(isCustomerNotificationTypeAllowed(type), true, `${type} is a permitted customer workflow`);
  }
});

test('customer policy rejects another account, company, or non-allowlisted event', () => {
  const base = { company_id: 'company-a', type: 'invoice_issued', details: { customer_id: 'customer-a', type: 'invoice_issued' } };
  assert.equal(isCustomerNotificationAuthorized(base, customerPrincipal), true);
  assert.equal(isCustomerNotificationAuthorized({ ...base, details: { ...base.details, customer_id: 'customer-b' } }, customerPrincipal), false);
  assert.equal(isCustomerNotificationAuthorized({ ...base, company_id: 'company-b' }, customerPrincipal), false);
  assert.equal(isCustomerNotificationAuthorized({ ...base, details: { ...base.details, type: 'payroll_processed' } }, customerPrincipal), false);
});

test('isolated two-company fixture returns only the authenticated customer service and invoice updates', () => {
  const fixtures = [
    { id: 'own-job', company_id: 'company-a', type: 'customer_job_accepted', title: 'Technician assigned', message: 'Your technician is assigned', details: { customer_id: 'customer-a', type: 'customer_job_accepted', job_id: 'job-a' } },
    { id: 'own-invoice', company_id: 'company-a', type: 'invoice_issued', title: 'Invoice ready ₹45,000', message: 'Your invoice is ready', details: { customer_id: 'customer-a', type: 'invoice_issued', invoice_id: 'invoice-a' } },
    { id: 'payroll', company_id: 'company-a', type: 'payroll_processed', title: 'Salary ₹90,000', message: 'Payroll processed', details: { customer_id: 'customer-a', type: 'payroll_processed' } },
    { id: 'attendance', company_id: 'company-a', type: 'attendance_exception', title: 'Employee absent', message: 'Shift exception', details: { customer_id: 'customer-a', type: 'attendance_exception' } },
    { id: 'materials', company_id: 'company-a', type: 'material_request_submitted', title: 'Purchase ₹5,000', message: 'Employee requested stock', details: { customer_id: 'customer-a', type: 'material_request_submitted' } },
    { id: 'employee-message', company_id: 'company-a', type: 'employee_message', title: 'Internal conversation', message: 'Private staff message', details: { customer_id: 'customer-a', type: 'employee_message' } },
    { id: 'other-customer-job', company_id: 'company-a', type: 'invoice_issued', title: 'Other account invoice', message: 'Invoice for other customer', details: { customer_id: 'customer-b', type: 'invoice_issued', invoice_id: 'invoice-b' } },
    { id: 'other-company', company_id: 'company-b', type: 'customer_job_accepted', title: 'Other company job', message: 'Other tenant', details: { customer_id: 'customer-a', type: 'customer_job_accepted', job_id: 'job-b' } },
  ];
  const response = fixtures.filter(row => isCustomerNotificationAuthorized(row, customerPrincipal));
  assert.deepEqual(response.map(row => row.id), ['own-job', 'own-invoice']);
  const serialized = JSON.stringify(response);
  for (const forbidden of ['Salary ₹90,000', 'Employee absent', 'Purchase ₹5,000', 'Private staff message', 'Other account invoice', 'Other company job', 'invoice-b', 'job-b']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not appear in customer response`);
  }
});

test('customer feed SQL scopes tenant, customer, event type and referenced owned job/invoice', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/customer/notifications.js'), 'utf8');
  assert.match(source, /a\.company_id::text = \$1::text/);
  assert.match(source, /details::jsonb->>'customer_id' = \$2::text/);
  assert.match(source, /COALESCE\(a\.details::jsonb->>'type', a\.action\) = ANY\(\$3::text\[\]\)/);
  assert.match(source, /j\.customer_id::text = \$2::text AND j\.company_id::text = \$1::text/);
  assert.match(source, /i\.customer_id::text = \$2::text AND i\.company_id::text = \$1::text/);
});

test('staff notification endpoints authorize against persisted role and scope all mutations by user/company', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/notifications.js'), 'utf8');
  assert.match(source, /SELECT id, role, company_id FROM users WHERE id::text = \$1::text/);
  assert.match(source, /INTERNAL_ROLES\.has\(String\(principal\.role/);
  assert.match(source, /router\.get\('\/', authenticateToken, requireInternalNotificationPrincipal/);
  assert.match(source, /router\.get\('\/:id', authenticateToken, requireInternalNotificationPrincipal/);
  assert.match(source, /router\.get\('\/sse', authenticateToken, requireInternalNotificationPrincipal/);
  assert.match(source, /router\.patch\('\/mark-all-read', authenticateToken, requireInternalNotificationPrincipal/);
  assert.match(source, /router\.patch\('\/:id\/read', authenticateToken, requireInternalNotificationPrincipal/);
  assert.match(source, /router\.post\('\/devices', authenticateToken, requireInternalNotificationPrincipal/);
  assert.match(source, /user_id::text = \$1::text/);
  assert.match(source, /company_id::text = \$2::text/);
});

test('company bulk notifications require one exact tenant and never select a global audience', () => {
  const source = fs.readFileSync(path.join(__dirname, '../utils/notificationHelpers.js'), 'utf8');
  assert.match(source, /if \(company_id == null \|\| String\(company_id\)\.trim\(\) === ''\) \{\s*return \{ success: true, count: 0 \};/);
  assert.match(source, /role = 'employee' AND company_id::text = \$1::text/);
  assert.match(source, /role IN \('owner', 'admin'\) AND company_id::text = \$1::text/);
  assert.doesNotMatch(source, /company_id::text = '1' OR company_id::text = '0' OR company_id IS NULL/);
});
