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

module.exports = {
  sendJobAssignedEmail,
  sendPayrollReleasedEmail,
  sendWelcomeEmail,
  sendJobCompletedEmail
};
