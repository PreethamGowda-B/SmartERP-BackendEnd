const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function runMigration() {
    try {
        console.log("🔄 Running migration: add_google_auth.sql");

        const migrationPath = path.join(__dirname, "migrations", "add_google_auth.sql");
        const sql = fs.readFileSync(migrationPath, "utf8");

        await pool.query(sql);

        console.log("✅ Migration completed successfully!");
        console.log("📋 Users table updated: added google_id and made password_hash nullable.");

    } catch (err) {
        console.error("❌ Migration failed:", err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runMigration();
