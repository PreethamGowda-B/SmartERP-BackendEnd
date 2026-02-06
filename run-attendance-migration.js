const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function runAttendanceMigration() {
    try {
        console.log("🔄 Running attendance tables migration...");
        console.log("📍 Database:", process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'unknown');

        const migrationPath = path.join(__dirname, "migrations", "create_attendance_tables.sql");
        const sql = fs.readFileSync(migrationPath, "utf8");

        await pool.query(sql);

        console.log("✅ Migration completed successfully!");
        console.log("📋 Attendance tables created");

        // Verify the tables structure
        console.log("\n📊 Attendance table structure:");
        const attendanceResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'attendance' 
      ORDER BY ordinal_position
    `);

        attendanceResult.rows.forEach(row => {
            console.log(`  - ${row.column_name}: ${row.data_type}`);
        });

        console.log("\n📊 Attendance corrections table structure:");
        const correctionsResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'attendance_corrections' 
      ORDER BY ordinal_position
    `);

        correctionsResult.rows.forEach(row => {
            console.log(`  - ${row.column_name}: ${row.data_type}`);
        });

        console.log("\n🎉 Attendance system database is ready!");

    } catch (err) {
        console.error("❌ Migration failed:", err.message);
        console.error("Full error:", err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runAttendanceMigration();
