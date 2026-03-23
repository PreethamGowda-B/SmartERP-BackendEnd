require('dotenv').config();
const { pool } = require('../db-base');

async function run() {
  const fcmToken = 'test_fcm_token_from_apk_simulation_%';
  
  const res = await pool.query(
    `SELECT * FROM user_devices WHERE fcm_token LIKE $1`,
    [fcmToken]
  );
  
  console.log(`\n🔍 Found check:`, res.rows.length, `rows`);
  console.log(res.rows);
  
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
