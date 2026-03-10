const { pool } = require('./db');
require('dotenv').config();

async function checkRecentLogins() {
    try {
        console.log('--- Checking User Details for thepreethu01@gmail.com ---');
        const res = await pool.query("SELECT id, email, role, push_token, company_id FROM users WHERE email = 'thepreethu01@gmail.com'");
        console.log(JSON.stringify(res.rows, null, 2));

        console.log('\n--- Checking for potential duplicate owner accounts ---');
        const dupRes = await pool.query("SELECT id, email, push_token, role FROM users WHERE role = 'owner'");
        console.log(JSON.stringify(dupRes.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

checkRecentLogins();
