const { pool } = require('./db');
const fs = require('fs');
const path = require('path');

async function runMigration() {
    try {
        console.log("🚀 Running fix_reviewed_by migration...");
        const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'fix_reviewed_by.sql'), 'utf8');
        await pool.query(sql);
        console.log("✅ Migration applied successfully.");
    } catch (err) {
        console.error("❌ Migration failed:", err);
    } finally {
        pool.end();
    }
}

runMigration();
