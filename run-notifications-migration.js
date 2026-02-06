const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function runNotificationsMigration() {
    try {
        console.log("🔄 Running notifications table migration...");
        console.log("📍 Database:", process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'unknown');

        const migrationPath = path.join(__dirname, "migrations", "create_notifications_table.sql");
        const sql = fs.readFileSync(migrationPath, "utf8");

        await pool.query(sql);

        console.log("✅ Migration completed successfully!");
        console.log("📋 Notifications table created");

        // Verify the table structure
        const result = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'notifications' 
      ORDER BY ordinal_position
    `);

        console.log("\n📊 Notifications table structure:");
        result.rows.forEach(row => {
            console.log(`  - ${row.column_name}: ${row.data_type}`);
        });

        console.log("\n🎉 Notifications system is ready!");

    } catch (err) {
        console.error("❌ Migration failed:", err.message);
        console.error("Full error:", err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runNotificationsMigration();
