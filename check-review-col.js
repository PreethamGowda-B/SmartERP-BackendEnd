const { pool } = require('./db');

async function checkReviewColumn() {
    try {
        console.log("🔍 Checking material_requests Table reviewed_by Type:");
        const res = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'material_requests' AND column_name = 'reviewed_by';
    `);
        console.log(res.rows);
    } catch (err) {
        console.error("Error:", err);
    } finally {
        pool.end();
    }
}

checkReviewColumn();
