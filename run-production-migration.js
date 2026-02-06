const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function runProductionMigration() {
    try {
        console.log("🔄 Running migration on PRODUCTION database...");
        console.log("📍 Database:", process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'unknown');

        const migrationPath = path.join(__dirname, "migrations", "fix_material_requests_types.sql");
        const sql = fs.readFileSync(migrationPath, "utf8");

        console.log("\n⚠️  WARNING: This will DROP and RECREATE the material_requests table!");
        console.log("⚠️  All existing material requests data will be LOST!");
        console.log("\nProceeding in 3 seconds...\n");

        await new Promise(resolve => setTimeout(resolve, 3000));

        await pool.query(sql);

        console.log("✅ Migration completed successfully on PRODUCTION!");
        console.log("📋 Material requests table has been recreated with UUID types");

        // Verify the table structure
        const result = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'material_requests' 
      ORDER BY ordinal_position
    `);

        console.log("\n📊 Current PRODUCTION table structure:");
        result.rows.forEach(row => {
            const marker = (row.column_name === 'requested_by' || row.column_name === 'reviewed_by') ? ' ✅' : '';
            console.log(`  - ${row.column_name}: ${row.data_type}${marker}`);
        });

        console.log("\n🎉 Production database is now ready!");

    } catch (err) {
        console.error("❌ Migration failed:", err.message);
        console.error("Full error:", err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runProductionMigration();
