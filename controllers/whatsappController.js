/**
 * controllers/whatsappController.js
 * Meta WhatsApp Cloud API Webhook Controller
 */
const whatsappWebhookService = require('../services/whatsappWebhookService');
const crypto = require('crypto');

function verifyMetaWebhookSignature({ rawBody, signature, appSecret }) {
  if (!appSecret || !rawBody || typeof signature !== 'string') return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signature.trim());
  if (!match) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const actualBytes = Buffer.from(match[1], 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * GET /webhooks/whatsapp
 * Verification endpoint required by Meta Facebook Developer Portal setup
 */
function verifyWebhook(req, res) {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const expectedToken = String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim();

    // Verification tokens and challenges are credentials supplied in the URL.
    // Do not copy either value into logs, which are broadly retained and may
    // be available to operational personnel.
    console.log('📲 [WhatsApp Webhook Verification Request]', { mode: mode || 'missing' });

    if (!expectedToken) {
      console.error('[WhatsApp Webhook Verification] Configuration missing: WHATSAPP_VERIFY_TOKEN');
      return res.status(503).json({ error: 'Service Unavailable', message: 'Webhook verification is not configured.' });
    }

    if (mode === 'subscribe' && typeof token === 'string' && token.length === expectedToken.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken))) {
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
    const appSecret = String(process.env.WHATSAPP_APP_SECRET || '').trim();
    if (!appSecret) {
      console.error('[WhatsApp Webhook] Configuration missing: WHATSAPP_APP_SECRET');
      return res.status(503).json({ error: 'Service Unavailable', message: 'Webhook event verification is not configured.' });
    }
    if (!Buffer.isBuffer(req.rawBody)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Webhook payload could not be verified.' });
    }
    if (!verifyMetaWebhookSignature({
      rawBody: req.rawBody,
      signature: req.get?.('x-hub-signature-256') || req.headers?.['x-hub-signature-256'],
      appSecret,
    })) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid webhook signature.' });
    }

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
  handleWebhookEvent,
  verifyMetaWebhookSignature,
};
