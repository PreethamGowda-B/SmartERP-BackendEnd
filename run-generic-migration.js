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
        const migrationFile = process.argv[2];
        if (!migrationFile) {
            console.error("❌ Please provide a migration file path as an argument.");
            process.exit(1);
        }

        const migrationPath = path.isAbsolute(migrationFile)
            ? migrationFile
            : path.join(__dirname, migrationFile);

        console.log(`🔄 Running migration: ${migrationPath}`);
        const sql = fs.readFileSync(migrationPath, "utf8");

        await pool.query(sql);

        console.log("✅ Migration completed successfully!");

    } catch (err) {
        console.error("❌ Migration failed:", err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runMigration();
