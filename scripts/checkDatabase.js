const { pool } = require('../db');
require('dotenv').config();

async function checkDatabase() {
    try {
        // Check all users
        const users = await pool.query('SELECT id, email, role, name, created_at FROM users ORDER BY created_at');
        console.log('\n📋 USERS:');
        console.table(users.rows);

        // Check all jobs with creator info
        const jobs = await pool.query(`
      SELECT j.id, j.title, j.status, j.created_by, u.email as creator_email, j.created_at 
      FROM jobs j
      LEFT JOIN users u ON j.created_by = u.id
      ORDER BY j.created_at DESC
    `);
        console.log('\n📋 JOBS:');
        console.table(jobs.rows);

        // Check jobs count per user
        const jobCounts = await pool.query(`
      SELECT u.email, u.role, COUNT(j.id) as job_count
      FROM users u
      LEFT JOIN jobs j ON j.created_by = u.id
      GROUP BY u.id, u.email, u.role
    `);
        console.log('\n📊 JOBS PER USER:');
        console.table(jobCounts.rows);

        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

checkDatabase();
