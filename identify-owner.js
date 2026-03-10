const { pool } = require('./db');
require('dotenv').config();

async function findCurrentOwner() {
    try {
        console.log('--- Database Owners ---');
        const res = await pool.query("SELECT id, email, push_token FROM users WHERE role = 'owner'");
        console.log(JSON.stringify(res.rows, null, 2));

        console.log('\n--- Recent Job Creator ---');
        const jobRes = await pool.query("SELECT created_by, COUNT(*) FROM jobs GROUP BY created_by");
        console.log(JSON.stringify(jobRes.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

findCurrentOwner();
