const { pool } = require('./db');

async function checkSchema() {
    try {
        console.log("🔍 Checking Users Table ID Type:");
        const usersRes = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'id';
    `);
        console.log(usersRes.rows);

        console.log("\n🔍 Checking Jobs Table ID Type:");
        const jobsRes = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'jobs' AND column_name = 'id';
    `);
        console.log(jobsRes.rows);

        console.log("\n🔍 Checking Jobs Table Assigned_To Type:");
        const assignedRes = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'jobs' AND column_name = 'assigned_to';
    `);
        console.log(assignedRes.rows);

    } catch (err) {
        console.error("Error:", err);
    } finally {
        pool.end();
    }
}

checkSchema();
