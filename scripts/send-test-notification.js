require('dotenv').config();
const { pool } = require('../db-base');
const { sendPushNotification } = require('../services/firebaseService');

async function run() {
  const email = 'thepreethu01@gmail.com';

  // First check legacy push_token in users table (where APK stores its token)
  const userRes = await pool.query(
    `SELECT id, name, email, push_token FROM users WHERE email ILIKE $1`,
    [email]
  );

  if (userRes.rows.length === 0) {
    console.log('❌ User not found:', email);
    await pool.end();
    return;
  }

  const user = userRes.rows[0];
  console.log(`\n👤 User: ${user.name} (${user.email})`);
  console.log(`📱 APK push_token (users table): ${user.push_token ? user.push_token.substring(0, 60) + '...' : '❌ NULL / not set'}`);

  // Also check user_devices
  const devRes = await pool.query(
    `SELECT fcm_token, device_type, last_seen FROM user_devices WHERE user_id::text = $1::text ORDER BY last_seen DESC`,
    [user.id]
  );
  console.log(`\n📋 user_devices entries: ${devRes.rows.length}`);
  devRes.rows.forEach((r, i) => {
    console.log(`  [${i+1}] ${r.device_type} - last seen: ${r.last_seen}`);
    console.log(`       Token: ${r.fcm_token.substring(0, 60)}...`);
  });

  // Try sending to APK token if it exists
  if (user.push_token) {
    console.log('\n📤 Sending notification to APK token (users.push_token)...');
    try {
      const result = await sendPushNotification(
        user.push_token,
        '🔔 SmartERP',
        `Hi ${user.name}! Mobile push notification test ✅`,
        { type: 'test', url: '/owner' }
      );
      console.log('✅ Sent to APK token! Check your phone.');
      console.log('Result:', JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('❌ APK token failed:', err.message);
      if (err.errorInfo) console.error('   FCM code:', err.errorInfo.code);
    }
  } else {
    console.log('\n❌ No APK token found. The APK has not registered a push token yet.');
    console.log('   Try: Open the APK → log in → go to dashboard → wait 5 seconds.');
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
