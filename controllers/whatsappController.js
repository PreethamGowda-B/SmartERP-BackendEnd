/**
 * controllers/whatsappController.js
 * Meta WhatsApp Cloud API Webhook Controller
 */
const whatsappWebhookService = require('../services/whatsappWebhookService');

/**
 * GET /webhooks/whatsapp
 * Verification endpoint required by Meta Facebook Developer Portal setup
 */
function verifyWebhook(req, res) {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const expectedToken = (process.env.WHATSAPP_VERIFY_TOKEN || 'smarterp_whatsapp_verify_token_2026').trim();

    console.log('📲 [WhatsApp Webhook Verification Request]');
    console.log(`   - hub.mode: ${mode}`);
    console.log(`   - Received Token: "${token}"`);
    console.log(`   - Expected Token: "${expectedToken}"`);
    console.log(`   - hub.challenge: ${challenge}`);

    if (mode === 'subscribe' && token === expectedToken) {
      console.log('✅ [WhatsApp Webhook Verification] SUCCESS! Returning HTTP 200 with hub.challenge.');
      return res.status(200).send(challenge);
    } else {
      console.warn('❌ [WhatsApp Webhook Verification] FAILED: Token or mode mismatch.');
      return res.status(403).json({
        error: 'Forbidden',
        message: 'WhatsApp Webhook verification failed. Token or mode mismatch.'
      });
    }
  } catch (err) {
    console.error('❌ [WhatsApp Webhook Verification] Unexpected error:', err.message);
    return res.status(500).send('Server Error');
  }
}

/**
 * POST /webhooks/whatsapp
 * Receiver endpoint for incoming messages, status updates, and read receipts
 */
async function handleWebhookEvent(req, res) {
  try {
    // 1. Acknowledge Meta immediately with HTTP 200 to prevent event retries
    res.status(200).send('EVENT_RECEIVED');

    // 2. Process payload asynchronously
    whatsappWebhookService.processWebhookEvent(req.body).catch(err => {
      console.error('❌ [WhatsApp Webhook Event Error]:', err.message);
    });
  } catch (err) {
    console.error('❌ [WhatsApp Webhook Controller Error]:', err.message);
    // Ensure 200 response if headers haven't been sent
    if (!res.headersSent) {
      res.status(200).send('EVENT_RECEIVED');
    }
  }
}

module.exports = {
  verifyWebhook,
  handleWebhookEvent
};
