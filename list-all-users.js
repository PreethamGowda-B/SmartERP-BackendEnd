const { pool } = require('./db');
require('dotenv').config();

async function listAllUsers() {
    try {
        console.log('--- All Users, Roles, and Companies ---');
        const res = await pool.query("SELECT id, email, role, company_id FROM users");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

listAllUsers();
