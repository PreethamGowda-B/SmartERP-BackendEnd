require('dotenv').config();
const { pool } = require('../db-base');
const { sendPushNotification } = require('../services/firebaseService');

async function run() {
  const email = 'thepreethu01@gmail.com';

  console.log(`\n🔍 Looking up NEW FCM tokens in user_devices for: ${email}\n`);
  
  // Only look at user_devices, not the legacy user table
  const res = await pool.query(
    `SELECT ud.fcm_token, ud.device_type, ud.last_seen, u.name, u.email 
     FROM user_devices ud 
     JOIN users u ON ud.user_id::text = u.id::text 
     WHERE u.email ILIKE $1 
     -- Ignore our simulation token
     AND ud.fcm_token NOT LIKE 'test_fcm_token_%'
     ORDER BY ud.last_seen DESC`,
    [email]
  );

  if (res.rows.length === 0) {
    console.log('❌ No valid FCM tokens found in user_devices.');
    await pool.end();
    return;
  }

  const target = res.rows[0];
  console.log(`✅ Found ${res.rows.length} device(s). Targeting most recent:`);
  console.log(`   Device Type: ${target.device_type}`);
  console.log(`   Last Seen:   ${target.last_seen}`);
  console.log(`   Token:       ${target.fcm_token.substring(0, 50)}...`);

  console.log(`\n📤 Sending Notification...`);

  try {
    const result = await sendPushNotification(
      target.fcm_token,
      '📱 Mobile Test',
      'If you see this on your phone, the bug is 100% fixed!',
      { type: 'test', url: '/owner' }
    );
    console.log('\n✅ SUCCESS! Notification sent via Firebase.');
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('\n❌ Failed to send:', err.message);
    if (err.errorInfo) {
      console.error('   FCM Error:', err.errorInfo.code);
    }
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
