/**
 * services/whatsappWebhookService.js
 * Scalable Asynchronous Webhook Processor for Meta WhatsApp Cloud API
 */
const { pool } = require('../db');

class WhatsAppWebhookService {
  /**
   * Main entry point for processing incoming WhatsApp webhook events
   */
  async processWebhookEvent(body) {
    try {
      if (!body.object || body.object !== 'whatsapp_business_account') {
        console.log('ℹ️ [WhatsApp Webhook] Received non-WhatsApp object type:', body.object);
        return { handled: false, reason: 'invalid_object_type' };
      }

      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value || {};

          // 1. Process Messages (Text, Media, Interactive, Quick Replies)
          if (value.messages && value.messages.length > 0) {
            for (const message of value.messages) {
              await this.handleIncomingMessage(message, value.contacts, value.metadata);
            }
          }

          // 2. Process Message Statuses (Sent, Delivered, Read, Failed)
          if (value.statuses && value.statuses.length > 0) {
            for (const status of value.statuses) {
              await this.handleMessageStatus(status, value.metadata);
            }
          }
        }
      }

      return { handled: true };
    } catch (err) {
      console.error('❌ [WhatsApp Webhook Service] Processing error:', err);
      return { handled: false, error: err.message };
    }
  }

  /**
   * Handles incoming message payloads
   */
  async handleIncomingMessage(message, contacts = [], metadata = {}) {
    const fromPhone = message.from;
    const msgId = message.id;
    const msgType = message.type;
    const timestamp = new Date(parseInt(message.timestamp) * 1000);

    let contentText = '';
    if (msgType === 'text') {
      contentText = message.text?.body || '';
    } else if (msgType === 'button') {
      contentText = message.button?.text || '';
    } else if (msgType === 'interactive') {
      contentText = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
    } else {
      contentText = `[Media/Other message type: ${msgType}]`;
    }

    const contactName = contacts.find(c => c.wa_id === fromPhone)?.profile?.name || 'WhatsApp User';

    console.log(`💬 [WhatsApp Incoming] From: ${contactName} (+${fromPhone}) | Type: ${msgType} | Content: "${contentText}"`);

    // Log event to DB if messages table exists
    try {
      await pool.query(
        `INSERT INTO activities (action, activity_type, details, created_at)
         VALUES ($1, 'whatsapp_incoming_message', $2, NOW())`,
        [`WhatsApp Message from +${fromPhone}`, JSON.stringify({ message_id: msgId, from: fromPhone, name: contactName, content: contentText, type: msgType })]
      );
    } catch (dbErr) {
      // Non-fatal logging
    }
  }

  /**
   * Handles message delivery status updates (sent, delivered, read, failed)
   */
  async handleMessageStatus(status, metadata = {}) {
    const msgId = status.id;
    const recipientId = status.recipient_id;
    const statusType = status.status; // 'sent', 'delivered', 'read', 'failed'
    const timestamp = new Date(parseInt(status.timestamp) * 1000);

    if (statusType === 'failed') {
      const errors = status.errors || [];
      console.error(`⚠️ [WhatsApp Status] Message ${msgId} to +${recipientId} FAILED:`, errors);
    } else {
      console.log(`📊 [WhatsApp Status] Message ${msgId} to +${recipientId}: ${statusType.toUpperCase()} at ${timestamp.toISOString()}`);
    }

    try {
      await pool.query(
        `INSERT INTO activities (action, activity_type, details, created_at)
         VALUES ($1, 'whatsapp_status_update', $2, NOW())`,
        [`WhatsApp Status: ${statusType}`, JSON.stringify({ message_id: msgId, recipient: recipientId, status: statusType, errors: status.errors || null })]
      );
    } catch (dbErr) {
      // Non-fatal logging
    }
  }
}

module.exports = new WhatsAppWebhookService();
