require('dotenv').config();
const { pool } = require('../db-base');

async function run() {
  const res = await pool.query(
    `SELECT ud.id, ud.fcm_token, ud.device_type, ud.last_seen, u.name, u.email
     FROM user_devices ud
     JOIN users u ON ud.user_id::text = u.id::text
     WHERE u.email ILIKE '%thepreethu01%'
     ORDER BY ud.last_seen DESC`
  );
  console.log('\n📱 All registered devices for thepreethu01:\n');
  if (res.rows.length === 0) {
    console.log('❌ No devices found.');
  } else {
    res.rows.forEach((r, i) => {
      console.log(`[${i+1}] Device Type: ${r.device_type}`);
      console.log(`     Last Seen:  ${r.last_seen}`);
      console.log(`     Token:      ${r.fcm_token.substring(0, 60)}...`);
      console.log('');
    });
  }
  await pool.end();
}
run().catch(e => { console.error(e); process.exit(1); });
