const { pool } = require('./db');
require('dotenv').config();

async function checkRecentNotifications() {
    try {
        console.log('--- Latest 5 Notifications ---');
        const res = await pool.query(`
            SELECT n.id, n.user_id, n.type, n.title, n.message, n.created_at, u.email, u.push_token 
            FROM notifications n
            JOIN users u ON n.user_id = u.id
            ORDER BY n.created_at DESC LIMIT 5
        `);
        console.log(JSON.stringify(res.rows, null, 2));

        console.log('\n--- Latest Job ---');
        const jobRes = await pool.query(`
            SELECT id, title, created_by, company_id, visible_to_all, created_at 
            FROM jobs 
            ORDER BY created_at DESC LIMIT 1
        `);
        console.log(JSON.stringify(jobRes.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

checkRecentNotifications();
