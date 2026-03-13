require('dotenv').config();
const { pool } = require('./db');

async function grantProTier(email) {
  try {
    const userRes = await pool.query(`SELECT company_id FROM users WHERE email = $1`, [email]);
    if (userRes.rows.length === 0) {
      console.log(`User ${email} not found.`);
      process.exit(1);
    }
    const companyId = userRes.rows[0].company_id;

    await pool.query(
      `UPDATE companies 
       SET plan_id = 3, 
           is_on_trial = true, 
           trial_started_at = NOW(),
           trial_ends_at = NOW() + INTERVAL '30 days',
           subscription_expires_at = NOW() + INTERVAL '30 days',
           is_first_login = true
       WHERE id = $1`,
      [companyId]
    );
    console.log(`✅ Granted 30-day Pro Trial to company ID ${companyId} belonging to ${email}`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
if (args[0]) grantProTier(args[0]);
else console.log('Provide an email');
