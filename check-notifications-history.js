const { pool } = require('./db');
require('dotenv').config();

async function checkNotifications() {
    try {
        const res = await pool.query("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 20");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

checkNotifications();
