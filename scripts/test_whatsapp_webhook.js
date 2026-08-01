/**
 * scripts/test_whatsapp_webhook.js
 * Verification script for Meta WhatsApp Cloud API Webhook Integration using native Express & HTTP
 */
const express = require('express');
const http = require('http');

// Load environment variables
require('dotenv').config();

const app = express();
app.use(express.json());

// Mount whatsapp routes
const whatsappRoutes = require('../routes/whatsapp');
app.use('/webhooks/whatsapp', whatsappRoutes);
app.use('/api/webhooks/whatsapp', whatsappRoutes);

let server;

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (postData) req.write(JSON.stringify(postData));
    req.end();
  });
}

async function runWhatsAppWebhookTests() {
  console.log('\n--- VERIFYING META WHATSAPP CLOUD API WEBHOOK INTEGRATION ---\n');

  const expectedToken = (process.env.WHATSAPP_VERIFY_TOKEN || 'smarterp_whatsapp_verify_token_2026').trim();
  console.log(`📌 Using Expected Verify Token: "${expectedToken}"`);

  server = app.listen(0, async () => {
    const port = server.address().port;

    try {
      // 1. GET Verification - Success Case
      console.log('\n1. Testing GET /webhooks/whatsapp Verification (VALID TOKEN)...');
      const challengeCode = '1158201484_meta_test_challenge';

      const res1 = await makeRequest({
        hostname: 'localhost',
        port: port,
        path: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(expectedToken)}&hub.challenge=${encodeURIComponent(challengeCode)}`,
        method: 'GET'
      });

      console.log(`   - HTTP Status: ${res1.status}`);
      console.log(`   - Response Text: "${res1.body}"`);

      if (res1.status === 200 && res1.body === challengeCode) {
        console.log('✅ GET Verification PASSED: Returned HTTP 200 with exact hub.challenge!');
      } else {
        throw new Error(`GET Verification failed: status ${res1.status}, body: ${res1.body}`);
      }

      // 2. GET Verification - Invalid Token Case
      console.log('\n2. Testing GET /webhooks/whatsapp Verification (INVALID TOKEN)...');
      const res2 = await makeRequest({
        hostname: 'localhost',
        port: port,
        path: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token_1234&hub.challenge=${encodeURIComponent(challengeCode)}`,
        method: 'GET'
      });

      console.log(`   - HTTP Status: ${res2.status}`);
      if (res2.status === 403) {
        console.log('✅ Invalid Token Block PASSED: Returned HTTP 403 Forbidden!');
      } else {
        throw new Error(`Invalid token test failed: status ${res2.status}`);
      }

      // 3. POST Webhook Event - Incoming Text Message
      console.log('\n3. Testing POST /webhooks/whatsapp (INCOMING MESSAGE EVENT)...');
      const mockIncomingMsgPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '100609346383421',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15550248165', phone_number_id: '100609346383421' },
                  contacts: [{ profile: { name: 'John Field Lead' }, wa_id: '919876543210' }],
                  messages: [
                    {
                      from: '919876543210',
                      id: 'wamid.HBgLOTE5ODc2NTQzMjEwFQIAERgSQjE4RjlBQTA5M0U2N0I2OTM2AA==',
                      timestamp: '1785593800',
                      text: { body: 'Job #1024 HVAC service completed on site.' },
                      type: 'text'
                    }
                  ]
                },
                field: 'messages'
              }
            ]
          }
        ]
      };

      const res3 = await makeRequest({
        hostname: 'localhost',
        port: port,
        path: '/webhooks/whatsapp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, mockIncomingMsgPayload);

      console.log(`   - HTTP Status: ${res3.status}`);
      console.log(`   - Response Text: "${res3.body}"`);

      if (res3.status === 200) {
        console.log('✅ POST Incoming Message PASSED: Returned HTTP 200 immediately!');
      } else {
        throw new Error(`POST Incoming message failed: status ${res3.status}`);
      }

      // 4. POST Webhook Event - Status Update (Read Receipt)
      console.log('\n4. Testing POST /webhooks/whatsapp (MESSAGE READ RECEIPT STATUS)...');
      const mockStatusPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '100609346383421',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15550248165', phone_number_id: '100609346383421' },
                  statuses: [
                    {
                      id: 'wamid.HBgLOTE5ODc2NTQzMjEwFQIAERgSQjE4RjlBQTA5M0U2N0I2OTM2AA==',
                      status: 'read',
                      timestamp: '1785593810',
                      recipient_id: '919876543210'
                    }
                  ]
                },
                field: 'messages'
              }
            ]
          }
        ]
      };

      const res4 = await makeRequest({
        hostname: 'localhost',
        port: port,
        path: '/webhooks/whatsapp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, mockStatusPayload);

      console.log(`   - HTTP Status: ${res4.status}`);
      console.log(`   - Response Text: "${res4.body}"`);

      if (res4.status === 200) {
        console.log('✅ POST Status Update PASSED: Returned HTTP 200 immediately!');
      } else {
        throw new Error(`POST Status update failed: status ${res4.status}`);
      }

      console.log('\n🎉 ALL META WHATSAPP CLOUD API WEBHOOK TESTS PASSED SUCCESSFULLY!\n');
      server.close();
      process.exit(0);
    } catch (err) {
      console.error('❌ Test execution error:', err.message);
      if (server) server.close();
      process.exit(1);
    }
  });
}

runWhatsAppWebhookTests().catch(err => {
  console.error('❌ Initialization error:', err);
  process.exit(1);
});
