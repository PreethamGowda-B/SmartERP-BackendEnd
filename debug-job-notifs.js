const { pool } = require('./db');
require('dotenv').config();

async function checkJobNotificationContext() {
    try {
        console.log('--- Checking Jobs ---');
        const jobsRes = await pool.query('SELECT id, title, created_by, assigned_to, company_id FROM jobs LIMIT 5');
        for (const job of jobsRes.rows) {
            console.log(`Job: ${job.title}, CreatedBy: ${job.created_by}, AssignedTo: ${job.assigned_to}, Company: ${job.company_id}`);

            // Check owner (creator)
            const ownerRes = await pool.query('SELECT id, email, role, push_token, company_id FROM users WHERE id = $1', [job.created_by]);
            if (ownerRes.rows.length > 0) {
                const owner = ownerRes.rows[0];
                console.log(`  Owner: ${owner.email}, Role: ${owner.role}, Token: ${owner.push_token ? 'YES' : 'NO'}, UserCompany: ${owner.company_id}`);
            } else {
                console.log(`  Owner ${job.created_by} NOT FOUND`);
            }

            // Check assigned employee
            if (job.assigned_to) {
                const empRes = await pool.query('SELECT id, email, role, push_token, company_id FROM users WHERE id = $1', [job.assigned_to]);
                if (empRes.rows.length > 0) {
                    const emp = empRes.rows[0];
                    console.log(`  Employee: ${emp.email}, Role: ${emp.role}, Token: ${emp.push_token ? 'YES' : 'NO'}, UserCompany: ${emp.company_id}`);
                } else {
                    console.log(`  Employee ${job.assigned_to} NOT FOUND`);
                }
            }
        }
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

checkJobNotificationContext();
