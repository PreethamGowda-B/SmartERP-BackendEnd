require('dotenv').config();
const { pool } = require('../db-base');

async function run() {
  console.log(`\n🔍 Checking user_devices for new APK token...`);
  
  const res = await pool.query(`
    SELECT ud.fcm_token, ud.device_type, ud.last_seen, u.name, u.email 
    FROM user_devices ud 
    JOIN users u ON ud.user_id::text = u.id::text 
    WHERE u.email ILIKE '%preethu01%' AND ud.device_type = 'mobile_android' 
    ORDER BY ud.last_seen DESC
  `);
  
  if (res.rows.length === 0) {
    console.log(`❌ No 'mobile_android' devices found for preethu01`);
  } else {
    console.log(`✅ Found ${res.rows.length} 'mobile_android' device(s):`);
    res.rows.forEach(r => {
      console.log(`   Email: ${r.email}`);
      console.log(`   Last Seen: ${r.last_seen}`);
      console.log(`   Token: ${r.fcm_token.substring(0, 40)}...\n`);
    });
  }
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
