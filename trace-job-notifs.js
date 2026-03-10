const { pool } = require('./db');
require('dotenv').config();

async function checkJobNotifications() {
    try {
        console.log('--- Checking notifications for latest job pppprprpr ---');
        const res = await pool.query(`
            SELECT n.title, n.message, n.user_id, u.email, u.push_token, n.created_at 
            FROM notifications n
            JOIN users u ON n.user_id = u.id
            WHERE n.title LIKE '%pppprprpr%' 
               OR n.message LIKE '%pppprprpr%'
               OR (n.type = 'job' AND n.created_at > NOW() - INTERVAL '1 hour')
            ORDER BY n.created_at DESC
        `);

        if (res.rows.length === 0) {
            console.log('NO NOTIFICATIONS FOUND in DB for the last hour or matching job text.');
        } else {
            res.rows.forEach(r => {
                console.log(`To: ${r.email} | Title: ${r.title} | Token: ${r.push_token ? 'YES' : 'NO'}`);
            });
        }

        console.log('\n--- Checking Job Details ---');
        const jobRes = await pool.query("SELECT * FROM jobs WHERE title = 'pppprprpr' OR description = 'pppprprpr' ORDER BY created_at DESC LIMIT 1");
        console.log(JSON.stringify(jobRes.rows, null, 2));

    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

checkJobNotifications();
