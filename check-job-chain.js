const { pool } = require('./db');
require('dotenv').config();

async function checkJobCreationChain() {
    try {
        console.log('--- Recent Jobs and their Creators ---');
        const res = await pool.query(`
            SELECT j.id, j.title, j.created_by, u.email as creator_email, u.push_token as creator_token 
            FROM jobs j 
            JOIN users u ON j.created_by = u.id 
            ORDER BY j.created_at DESC LIMIT 5
        `);
        console.log(JSON.stringify(res.rows, null, 2));

        console.log('\n--- Recent Notifications for Job Accepted ---');
        const notifRes = await pool.query(`
            SELECT * FROM notifications 
            WHERE type = 'job_accepted' 
            ORDER BY created_at DESC LIMIT 5
        `);
        console.log(JSON.stringify(notifRes.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

checkJobCreationChain();
