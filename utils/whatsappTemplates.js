/**
 * utils/whatsappTemplates.js
 * Pre-approved Meta WhatsApp Cloud API Template Payload Builders for SmartERP
 */

const WHATSAPP_TEMPLATES = {
  JOB_ASSIGNMENT: 'job_assignment_alert',
  JOB_STATUS_UPDATE: 'job_status_update',
  OTP_VERIFICATION: 'otp_verification',
  ATTENDANCE_REMINDER: 'attendance_reminder',
  PAYROLL_NOTICE: 'payroll_notice',
  MATERIAL_REQUEST_ALERT: 'material_request_alert',
  INVOICE_ALERT: 'invoice_alert',
  AI_SYSTEM_ALERT: 'ai_system_alert'
};

/**
 * Formats template parameters according to Meta WhatsApp Cloud API specs
 */
function buildTemplatePayload(recipientPhone, templateName, languageCode = 'en_US', parameters = []) {
  // Format phone number to E.164 without + or leading zeros
  const formattedPhone = String(recipientPhone).replace(/\D/g, '');

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: formattedPhone,
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: languageCode
      },
      components: [
        {
          type: 'body',
          parameters: parameters.map(param => ({
            type: 'text',
            text: String(param)
          }))
        }
      ]
    }
  };
}

module.exports = {
  WHATSAPP_TEMPLATES,
  buildTemplatePayload
};
