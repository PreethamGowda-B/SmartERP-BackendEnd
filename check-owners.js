const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function checkUsers() {
    try {
        console.log("🔍 Fetching owners...");
        // Current query in messages.js
        const currentQuery = `
      SELECT id, name, email, role, company_id 
      FROM users 
      WHERE role = 'owner' OR role = 'admin'
      ORDER BY role DESC
      LIMIT 1
    `;
        const currentResult = await pool.query(currentQuery);
        console.log("👉 Result of CURRENT /api/messages/owner query (no filter):");
        console.table(currentResult.rows);

        console.log("\n🔍 Fetching ALL owners/admins to see potential mismatches:");
        const allOwners = await pool.query(`
      SELECT id, name, email, role, company_id 
      FROM users 
      WHERE role = 'owner' OR role = 'admin'
    `);
        console.table(allOwners.rows);

        console.log("\n🔍 Fetching some employees:");
        const employees = await pool.query(`
      SELECT id, name, email, role, company_id 
      FROM users 
      WHERE role != 'owner' AND role != 'admin'
      LIMIT 5
    `);
        console.table(employees.rows);

    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        await pool.end();
    }
}

checkUsers();
