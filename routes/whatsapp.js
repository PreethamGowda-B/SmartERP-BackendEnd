/**
 * routes/whatsapp.js
 * Meta WhatsApp Cloud API Webhook Routes
 */
const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');

// GET verification for Meta Developer Portal
router.get('/', whatsappController.verifyWebhook);

// POST event notification receiver
router.post('/', whatsappController.handleWebhookEvent);

module.exports = router;
