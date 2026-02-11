const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// Mock request object to simulate auth middleware result
const mockReqWithCompany = { user: { userId: 'emp1', companyId: 1 } };
const mockReqNoCompany = { user: { userId: 'emp2', companyId: null } };

async function verifyFix() {
    try {
        // 1. Check for Company ID = 1 (Should match 'Preetham Gowda B' from previous check-owners output)
        console.log("🧪 Test 1: Fetching owner for Company ID 1...");
        const res1 = await pool.query(`
      SELECT id, name, email, company_id
      FROM users 
      WHERE (role = 'owner' OR role = 'admin') 
      AND company_id = $1
      ORDER BY role DESC
      LIMIT 1`, [1]);

        if (res1.rows.length > 0) {
            console.log("✅ Found:", res1.rows[0]);
        } else {
            console.log("❌ No owner found for Company 1");
        }

        // 2. Check for Company ID = NULL (Should match 'preethu' or similar)
        console.log("\n🧪 Test 2: Fetching owner for Company ID NULL...");
        const res2 = await pool.query(`
      SELECT id, name, email, company_id
      FROM users 
      WHERE (role = 'owner' OR role = 'admin') 
      AND company_id IS NULL
      ORDER BY role DESC
      LIMIT 1`, []);

        if (res2.rows.length > 0) {
            console.log("✅ Found:", res2.rows[0]);
        } else {
            console.log("❌ No owner found for Company NULL");
        }

    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        await pool.end();
    }
}

verifyFix();
