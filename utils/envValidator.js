/**
 * Production Environment & Secrets Safety Auditor
 * Validates presence, formatting, and secure configuration of all production environment variables
 * without ever logging or exposing actual secret values.
 */

function validateEnvironmentVariables() {
  if (!process.env.DATABASE_URL) {
    try { require('dotenv').config(); } catch (_) {}
  }
  const auditResults = {
    isValid: true,
    checkedAt: new Date().toISOString(),
    variables: []
  };

  const rules = [
    { key: 'DATABASE_URL', required: true, format: /^postgres(ql)?:\/\/.+/i, category: 'Database Connection' },
    { key: 'REDIS_URL', required: true, format: /^rediss?:\/\/.+/i, category: 'Telemetry & Sliding Window Cache' },
    { key: 'JWT_SECRET', required: true, minLength: 32, category: 'Authentication & Session Signing' },
    { key: 'JWT_REFRESH_SECRET', required: true, minLength: 32, category: 'Authentication & Token Refresh' },
    { key: 'FRONTEND_ORIGIN', required: false, category: 'CORS & Client Routing' },
    { key: 'RESEND_API_KEY', required: false, format: /^re_.+/i, category: 'Email & Out-of-Band Alerts' },
    { key: 'GROQ_API_KEY', required: false, category: 'AI Context Engine' },
    { key: 'CLOUDINARY_CLOUD_NAME', required: false, category: 'Media & File Storage' },
    { key: 'CLOUDINARY_API_KEY', required: false, category: 'Media & File Storage' },
    { key: 'CLOUDINARY_API_SECRET', required: false, category: 'Media & File Storage' },
    { key: 'FIREBASE_SERVICE_ACCOUNT', required: false, category: 'Mobile & Web Push Notifications' },
    { key: 'RAZORPAY_KEY_ID', required: false, category: 'Payment Processing' },
    { key: 'RAZORPAY_KEY_SECRET', required: false, category: 'Payment Processing' },
    { key: 'SENTRY_DSN', required: false, category: 'Error Monitoring & Telemetry' },
    { key: 'GOOGLE_CLIENT_ID', required: false, category: 'Google OAuth Single Sign-On' },
    { key: 'GOOGLE_CLIENT_SECRET', required: false, category: 'Google OAuth Single Sign-On' },
    { key: 'WHATSAPP_VERIFY_TOKEN', required: false, minLength: 16, category: 'WhatsApp Webhook Verification' },
    { key: 'WHATSAPP_APP_SECRET', required: false, minLength: 16, category: 'WhatsApp Webhook Signature Verification' },
    { key: 'SUPER_ADMIN_EMAIL', required: false, format: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, category: 'Super Admin Identity' },
  ];

  for (const rule of rules) {
    const rawValue = process.env[rule.key];
    const isPresent = Boolean(rawValue && rawValue.trim().length > 0);
    let formatValid = true;
    let failureReason = null;

    if (!isPresent) {
      if (rule.required) {
        auditResults.isValid = false;
        formatValid = false;
        failureReason = 'Missing mandatory production variable';
      }
    } else {
      if (rule.format && !rule.format.test(rawValue)) {
        auditResults.isValid = false;
        formatValid = false;
        failureReason = 'Invalid format or protocol scheme';
      }
      if (rule.minLength && rawValue.length < rule.minLength) {
        auditResults.isValid = false;
        formatValid = false;
        failureReason = `Insufficient entropy (length ${rawValue.length} < ${rule.minLength})`;
      }
    }

    auditResults.variables.push({
      key: rule.key,
      category: rule.category,
      required: rule.required,
      present: isPresent,
      valid: formatValid,
      // Never expose even a partial credential through an audit API or log.
      maskedPreview: isPresent ? 'SET' : 'NOT_SET',
      reason: failureReason
    });
  }

  return auditResults;
}

module.exports = {
  validateEnvironmentVariables
};
