const { pool } = require('./db');

async function checkCompanyId() {
    try {
        console.log("🔍 Checking notifications table schema:");
        const notifRes = await pool.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'notifications' AND column_name = 'company_id';
    `);
        console.log(notifRes.rows);

        console.log("\n🔍 Checking users table schema for company_id:");
        const userRes = await pool.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'company_id';
    `);
        console.log(userRes.rows);

    } catch (err) {
        console.error("Error:", err);
    } finally {
        pool.end();
    }
}

checkCompanyId();
