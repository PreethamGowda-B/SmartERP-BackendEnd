const { Pool } = require('pg');
const { createNotification } = require('./utils/notificationHelpers');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function verifyFix() {
    try {
        console.log("🔍 Fetching a user with company_id...");
        const userRes = await pool.query('SELECT id, company_id FROM users WHERE company_id IS NOT NULL LIMIT 1');

        if (userRes.rows.length === 0) {
            console.log("⚠️ No user with company_id found. Trying to find any user...");
            // This might fail if company_id is required now, but let's see. 
            // The schema allows null if we didn't add NOT NULL constraint (which we didn't in the migration).
        }

        const user = userRes.rows[0];
        if (!user) {
            console.error("❌ No users found to test with.");
            return;
        }

        console.log(`👤 Found user: ${user.id} (Company: ${user.company_id})`);

        console.log("📝 Creating test notification...");
        const notification = await createNotification({
            user_id: user.id,
            company_id: user.company_id,
            type: 'message',
            title: 'Verifying Fix',
            message: 'This is a test notification to verify the schema fix.',
            priority: 'high'
        });

        console.log("✅ Notification created:", notification);

        console.log("\n🔍 Fetching notifications for user...");
        const fetchRes = await pool.query(
            `SELECT * FROM notifications WHERE user_id = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 1`,
            [user.id, user.company_id]
        );

        if (fetchRes.rows.length > 0) {
            console.log("✅ Successfully fetched notification!");
            console.log(fetchRes.rows[0]);
        } else {
            console.error("❌ Failed to fetch notification.");
        }

    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        await pool.end();
    }
}

verifyFix();
