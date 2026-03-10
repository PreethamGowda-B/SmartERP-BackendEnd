const { pool } = require('./db');
require('dotenv').config();

async function findUser() {
    const email = 'mrpreethu714@gmail.com';
    try {
        const res = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
        if (res.rows.length > 0) {
            console.log(`ID: ${res.rows[0].id}`);
        } else {
            console.log('User not found');
        }
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

findUser();
