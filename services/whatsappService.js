/**
 * services/whatsappService.js
 * 
 * Meta WhatsApp Business Cloud API Integration
 * Uses official Graph API endpoint (https://graph.facebook.com/v18.0/{phone_number_id}/messages)
 * Requires pre-approved Meta message templates for business-initiated notifications.
 */
const fetch = require('node-fetch');

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '';

/**
 * Check if Meta WhatsApp Cloud API credentials are provided in environment
 */
function isWhatsAppConfigured() {
  return Boolean(
    WHATSAPP_ACCESS_TOKEN.trim() && 
    WHATSAPP_PHONE_NUMBER_ID.trim()
  );
}

/**
 * Send a WhatsApp notification using Meta Cloud API.
 * Uses Meta template structure for business-initiated messages.
 * 
 * @param {string} recipientPhone - Target phone number in E.164 format (e.g. +919876543210 or 919876543210)
 * @param {string} templateName - Meta pre-approved template name (e.g. 'job_assignment_alert', 'otp_verification', 'job_status_update')
 * @param {string} languageCode - Language code (default 'en_US')
 * @param {Array} components - Template body parameters (e.g. [{ type: 'body', parameters: [{ type: 'text', text: 'Job #123' }] }])
 */
async function sendWhatsAppTemplateMessage(recipientPhone, templateName, languageCode = 'en_US', components = []) {
  if (!isWhatsAppConfigured()) {
    console.log(`ℹ️ [WhatsApp Cloud API] Not configured (missing WHATSAPP_ACCESS_TOKEN / PHONE_NUMBER_ID). Skipping send to ${recipientPhone}.`);
    return { success: false, skipped: true, reason: 'not_configured' };
  }

  // Format recipient phone number: strip '+' and leading zeros/dashes
  const cleanPhone = String(recipientPhone).replace(/[^0-9]/g, '');
  if (!cleanPhone) {
    console.warn('⚠️ [WhatsApp Cloud API] Invalid recipient phone number:', recipientPhone);
    return { success: false, error: 'invalid_phone' };
  }

  const url = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components && components.length > 0 && { components })
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(`❌ [WhatsApp Cloud API] HTTP ${res.status} Error:`, data);
      return { success: false, error: data.error?.message || 'Meta API request failed', details: data };
    }

    console.log(`✅ [WhatsApp Cloud API] Message dispatched to ${cleanPhone} | Message ID: ${data.messages?.[0]?.id}`);
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    console.error('❌ [WhatsApp Cloud API] Network Error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  isWhatsAppConfigured,
  sendWhatsAppTemplateMessage,
  WHATSAPP_BUSINESS_ACCOUNT_ID
};
