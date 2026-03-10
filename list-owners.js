const { pool } = require('./db');
require('dotenv').config();

async function listOwners() {
    try {
        const res = await pool.query("SELECT id, email, role FROM users WHERE role = 'owner'");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

listOwners();
