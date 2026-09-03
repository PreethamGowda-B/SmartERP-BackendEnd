const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = 'SmartERP <noreply@prozync.in>';
const APP_URL = process.env.FRONTEND_ORIGIN || 'https://www.prozync.in';

/**
 * 📧 Email Notification Service
 * Wraps Resend to send branded transactional emails for key ERP events.
 * All functions are fire-and-forget safe — they never throw to the caller.
 */

// ─── Shared HTML wrapper ────────────────────────────────────────────────────
function htmlWrapper(title, bodyContent) {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f7fb;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f7fb;padding:32px 0;">
      <tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);padding:28px 40px;text-align:left;">
              <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">SmartERP</span>
              <span style="color:rgba(255,255,255,0.6);font-size:13px;display:block;margin-top:2px;">by Prozync Innovations</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              ${bodyContent}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;color:#94a3b8;font-size:12px;">
                © ${new Date().getFullYear()} Prozync Innovations · 
                <a href="${APP_URL}/privacy" style="color:#6366f1;text-decoration:none;">Privacy Policy</a> · 
                <a href="${APP_URL}/terms" style="color:#6366f1;text-decoration:none;">Terms of Service</a>
              </p>
              <p style="margin:8px 0 0;color:#94a3b8;font-size:11px;">You received this email because you have an account on SmartERP.</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
  </html>`;
}

// ─── 1. Job Assigned Email ───────────────────────────────────────────────────
async function sendJobAssignedEmail({ employeeEmail, employeeName, jobTitle, jobDescription, priority, deadline, ownerName }) {
  try {
    const priorityColor = { urgent: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' }[priority] || '#6366f1';
    
    const body = `
      <h2 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1e293b;">📋 New Job Assigned</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:15px;">Hi ${employeeName || 'there'}, you have been assigned a new job.</p>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px;">
        <h3 style="margin:0 0 12px;font-size:18px;color:#1e293b;">${jobTitle}</h3>
        ${jobDescription ? `<p style="margin:0 0 12px;color:#64748b;font-size:14px;">${jobDescription}</p>` : ''}
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <span style="display:inline-block;background:${priorityColor}20;color:${priorityColor};border:1px solid ${priorityColor}40;border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;text-transform:uppercase;">${priority || 'medium'} Priority</span>
          ${deadline ? `<span style="display:inline-block;background:#e0f2fe;color:#0369a1;border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;">Due: ${new Date(deadline).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>` : ''}
        </div>
        ${ownerName ? `<p style="margin:12px 0 0;color:#94a3b8;font-size:13px;">Assigned by: ${ownerName}</p>` : ''}
      </div>

      <a href="${APP_URL}/employee/notifications" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">View Job Details →</a>
    `;

    await resend.emails.send({
      from: FROM_EMAIL,
      to: employeeEmail,
      subject: `📋 New Job Assigned: ${jobTitle}`,
      html: htmlWrapper(`New Job: ${jobTitle}`, body)
    });
    console.log(`✅ [EmailService] Job assigned email sent to ${employeeEmail}`);
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send job assigned email:`, err.message);
  }
}

// ─── 2. Payroll Released Email ───────────────────────────────────────────────
async function sendPayrollReleasedEmail({ employeeEmail, employeeName, month, year, totalSalary, presentDays, deduction }) {
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthName = monthNames[(parseInt(month) - 1)] || month;

  try {
    const body = `
      <h2 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1e293b;">💰 Payroll Processed</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:15px;">Hi ${employeeName || 'there'}, your salary for <strong>${monthName} ${year}</strong> has been processed.</p>

      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin-bottom:24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:6px 0;color:#64748b;font-size:14px;">Period</td>
            <td style="padding:6px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">${monthName} ${year}</td>
          </tr>
          ${presentDays !== undefined ? `
          <tr>
            <td style="padding:6px 0;color:#64748b;font-size:14px;">Days Present</td>
            <td style="padding:6px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">${presentDays} days</td>
          </tr>` : ''}
          ${deduction ? `
          <tr>
            <td style="padding:6px 0;color:#64748b;font-size:14px;">Deductions</td>
            <td style="padding:6px 0;color:#ef4444;font-size:14px;font-weight:600;text-align:right;">−₹${Number(deduction).toLocaleString('en-IN')}</td>
          </tr>` : ''}
          <tr>
            <td style="padding:10px 0 0;color:#15803d;font-size:16px;font-weight:700;border-top:1px solid #bbf7d0;">Net Salary</td>
            <td style="padding:10px 0 0;color:#15803d;font-size:20px;font-weight:700;text-align:right;border-top:1px solid #bbf7d0;">₹${Number(totalSalary).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
          </tr>
        </table>
      </div>

      <a href="${APP_URL}/employee/payroll" style="display:inline-block;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">View Payslip →</a>
    `;

    await resend.emails.send({
      from: FROM_EMAIL,
      to: employeeEmail,
      subject: `💰 Salary for ${monthName} ${year} has been processed`,
      html: htmlWrapper(`Payroll: ${monthName} ${year}`, body)
    });
    console.log(`✅ [EmailService] Payroll email sent to ${employeeEmail}`);
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send payroll email:`, err.message);
  }
}

// ─── 3. Welcome Email ────────────────────────────────────────────────────────
async function sendWelcomeEmail({ email, name, companyName, role }) {
  try {
    const dashLink = role === 'owner' ? `${APP_URL}/owner` : `${APP_URL}/employee`;
    
    const body = `
      <h2 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1e293b;">👋 Welcome to SmartERP!</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:15px;">Hi ${name || 'there'}, your account is all set up${companyName ? ` for <strong>${companyName}</strong>` : ''}.</p>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px;">
        <p style="margin:0;color:#475569;font-size:14px;">You now have access to:</p>
        <ul style="margin:12px 0 0;padding-left:18px;color:#475569;font-size:14px;line-height:28px;">
          ${role === 'owner' ? `
          <li>📊 Business Dashboard & Analytics</li>
          <li>👥 Employee Management</li>
          <li>📋 Job Tracking & Assignments</li>
          <li>💰 Payroll Processing</li>
          <li>📦 Inventory & Materials</li>
          ` : `
          <li>📋 View & Accept Jobs</li>
          <li>⏰ Track Your Attendance</li>
          <li>💰 View Your Payslips</li>
          <li>📦 Request Materials</li>
          `}
        </ul>
      </div>

      <a href="${dashLink}" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">Go to Dashboard →</a>
    `;

    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `👋 Welcome to SmartERP, ${name || ''}!`,
      html: htmlWrapper('Welcome to SmartERP', body)
    });
    console.log(`✅ [EmailService] Welcome email sent to ${email}`);
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send welcome email:`, err.message);
  }
}

// ─── 4. Job Completed Email (to Owner) ─────────────────────────────────────
async function sendJobCompletedEmail({ ownerEmail, ownerName, employeeName, jobTitle }) {
  try {
    const body = `
      <h2 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1e293b;">✅ Job Completed!</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:15px;">Hi ${ownerName || 'there'}, great news — a job has been marked as complete.</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:14px;color:#64748b;">Job</p>
        <p style="margin:0 0 16px;font-size:18px;font-weight:700;color:#1e293b;">${jobTitle}</p>
        <p style="margin:0;font-size:14px;color:#64748b;">Completed by: <strong>${employeeName}</strong></p>
      </div>
      <a href="${APP_URL}/owner/jobs" style="display:inline-block;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">View Job →</a>
    `;

    await resend.emails.send({
      from: FROM_EMAIL,
      to: ownerEmail,
      subject: `✅ Job Completed: ${jobTitle}`,
      html: htmlWrapper(`Job Completed: ${jobTitle}`, body)
    });
    console.log(`✅ [EmailService] Job completed email sent to ${ownerEmail}`);
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send job completed email:`, err.message);
  }
}

// ─── 5. Feedback Reply Email (from Superadmin) ─────────────────────────────
async function sendFeedbackReplyEmail({ email, name, subject, originalMessage, replyMessage }) {
  try {
    const safeSubject = subject || 'No Subject';
    const body = `
      <h2 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1e293b;">Support Reply: ${safeSubject}</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:15px;">Hi ${name || 'there'}, our team has replied to your feedback.</p>

      <div style="background:#fff;border:1px solid #e2e8f0;border-left:4px solid #4f46e5;border-radius:8px;padding:20px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:13px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Message from SmartERP Support</p>
        <p style="margin:0;color:#1e293b;font-size:15px;line-height:24px;white-space:pre-wrap;">${replyMessage}</p>
      </div>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:12px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Your Original Message</p>
        <p style="margin:0;color:#64748b;font-size:14px;line-height:22px;font-style:italic;">"${originalMessage}"</p>
      </div>

      <p style="margin:0;color:#64748b;font-size:14px;">If you have any further questions, please submit a new feedback ticket via the dashboard. We're here to help!</p>
    `;

    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Reply to your feedback: ${safeSubject}`,
      html: htmlWrapper(`Support Reply: ${safeSubject}`, body)
    });
    console.log(`✅ [EmailService] Feedback reply email sent to ${email}`);
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send feedback reply email:`, err.message);
  }
}

// ─── 6. Subscription Invoice & Receipt Email (to Owner) ────────────────────
async function sendSubscriptionInvoiceEmail({
  ownerEmail,
  ownerName,
  companyName,
  planName,
  billingCycle,
  amount,
  invoiceNumber,
  paymentId,
  orderId,
  expiryDate
}) {
  try {
    const formattedAmount = Number(amount || 0).toLocaleString('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2
    });
    const formattedDate = new Date().toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const formattedExpiry = expiryDate
      ? new Date(expiryDate).toLocaleDateString('en-IN', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })
      : 'Active (Auto-Renewing)';

    const body = `
      <div style="margin-bottom:24px;">
        <span style="background:#e0e7ff;color:#4338ca;font-size:12px;font-weight:700;padding:4px 10px;border-radius:9999px;text-transform:uppercase;letter-spacing:0.5px;">Paid Invoice / Receipt</span>
        <h2 style="margin:12px 0 6px;font-size:24px;font-weight:700;color:#1e293b;">Subscription Invoice: ${invoiceNumber}</h2>
        <p style="margin:0;color:#64748b;font-size:14px;">Thank you for your subscription, ${ownerName || 'Valued Customer'}. Your payment was successful.</p>
      </div>

      <!-- Invoice Summary Card -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin-bottom:24px;">
        <tr>
          <td style="padding-bottom:12px;border-bottom:1px solid #e2e8f0;">
            <p style="margin:0;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Billed To</p>
            <p style="margin:4px 0 0;font-size:15px;font-weight:700;color:#1e293b;">${companyName || 'Your Company'}</p>
            <p style="margin:2px 0 0;font-size:13px;color:#64748b;">${ownerName || ''} (${ownerEmail})</p>
          </td>
          <td style="padding-bottom:12px;border-bottom:1px solid #e2e8f0;text-align:right;">
            <p style="margin:0;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Invoice Date</p>
            <p style="margin:4px 0 0;font-size:14px;font-weight:600;color:#1e293b;">${formattedDate}</p>
          </td>
        </tr>
        <tr>
          <td style="padding-top:16px;">
            <p style="margin:0;font-size:16px;font-weight:700;color:#1e293b;">SmartERP ${planName} Plan (${billingCycle === 'yearly' ? 'Annual' : 'Monthly'})</p>
            <p style="margin:4px 0 0;font-size:12px;color:#64748b;">Valid until: <strong>${formattedExpiry}</strong></p>
          </td>
          <td style="padding-top:16px;text-align:right;">
            <span style="font-size:22px;font-weight:800;color:#16a34a;">${formattedAmount}</span>
            <span style="display:block;font-size:11px;color:#16a34a;font-weight:600;">PAID IN FULL</span>
          </td>
        </tr>
      </table>

      <!-- Transaction Details -->
      <table width="100%" cellpadding="8" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;margin-bottom:24px;">
        <tr style="background:#f1f5f9;">
          <th align="left" style="color:#475569;font-weight:600;padding:8px 12px;">Transaction Field</th>
          <th align="right" style="color:#475569;font-weight:600;padding:8px 12px;">Details</th>
        </tr>
        <tr>
          <td style="color:#64748b;padding:8px 12px;border-bottom:1px solid #f1f5f9;">Payment ID</td>
          <td align="right" style="font-family:monospace;color:#1e293b;padding:8px 12px;border-bottom:1px solid #f1f5f9;">${paymentId}</td>
        </tr>
        <tr>
          <td style="color:#64748b;padding:8px 12px;border-bottom:1px solid #f1f5f9;">Order ID</td>
          <td align="right" style="font-family:monospace;color:#1e293b;padding:8px 12px;border-bottom:1px solid #f1f5f9;">${orderId}</td>
        </tr>
        <tr>
          <td style="color:#64748b;padding:8px 12px;">Payment Gateway</td>
          <td align="right" style="color:#1e293b;font-weight:600;padding:8px 12px;">Razorpay Secure</td>
        </tr>
      </table>

      <div style="text-align:center;margin-top:28px;">
        <a href="${APP_URL}/owner/billing" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:15px;box-shadow:0 4px 12px rgba(79,70,229,0.25);">Go to Billing & Subscription →</a>
      </div>
    `;

    await resend.emails.send({
      from: FROM_EMAIL,
      to: ownerEmail,
      subject: `🧾 Subscription Invoice ${invoiceNumber} – SmartERP ${planName}`,
      html: htmlWrapper(`Subscription Invoice: ${invoiceNumber}`, body)
    });
    console.log(`✅ [EmailService] Subscription invoice email sent to ${ownerEmail} for plan ${planName}`);
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send subscription invoice email:`, err.message);
  }
}

module.exports = {
  sendJobAssignedEmail,
  sendPayrollReleasedEmail,
  sendWelcomeEmail,
  sendJobCompletedEmail,
  sendFeedbackReplyEmail,
  sendSubscriptionInvoiceEmail
};
