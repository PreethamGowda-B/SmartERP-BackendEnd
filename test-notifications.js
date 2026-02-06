const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function testNotifications() {
    try {
        console.log("🧪 Testing Notification System\n");

        // 1. Check if notifications table exists
        console.log("1️⃣ Checking notifications table...");
        const tableCheck = await pool.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_name = 'notifications'
    `);

        if (tableCheck.rows[0].count === "0") {
            console.error("❌ Notifications table does not exist!");
            process.exit(1);
        }
        console.log("✅ Notifications table exists\n");

        // 2. Get a test employee
        console.log("2️⃣ Finding test employee...");
        const employeeResult = await pool.query(`
      SELECT id, name, email 
      FROM users 
      WHERE role = 'employee' 
      LIMIT 1
    `);

        if (employeeResult.rows.length === 0) {
            console.error("❌ No employees found in database!");
            process.exit(1);
        }

        const employee = employeeResult.rows[0];
        console.log(`✅ Found employee: ${employee.name} (${employee.email})\n`);

        // Use a dummy company_id (users table doesn't have company_id column)
        const companyId = "00000000-0000-0000-0000-000000000000";
        console.log(`✅ Using dummy company ID: ${companyId}\n`);

        // 3. Create test notifications for all types
        console.log("3️⃣ Creating test notifications...\n");

        const notifications = [
            {
                type: "job",
                title: "Test Job Notification",
                message: "This is a test job notification",
                priority: "high",
            },
            {
                type: "material_request",
                title: "Test Material Request Notification",
                message: "This is a test material request notification",
                priority: "medium",
            },
            {
                type: "payroll",
                title: "Test Payroll Notification",
                message: "This is a test payroll notification",
                priority: "high",
            },
            {
                type: "message",
                title: "Test Message Notification",
                message: "This is a test message notification",
                priority: "medium",
            },
        ];

        for (const notif of notifications) {
            const result = await pool.query(
                `INSERT INTO notifications (user_id, company_id, type, title, message, priority, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id, type, title`,
                [employee.id, companyId, notif.type, notif.title, notif.message, notif.priority]
            );

            console.log(`✅ Created ${notif.type} notification (ID: ${result.rows[0].id})`);
        }

        // 4. Verify notifications were created
        console.log("\n4️⃣ Verifying notifications...");
        const verifyResult = await pool.query(
            `SELECT id, type, title, message, read, created_at 
       FROM notifications 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 10`,
            [employee.id]
        );

        console.log(`✅ Found ${verifyResult.rows.length} notifications for employee\n`);

        verifyResult.rows.forEach((notif, index) => {
            console.log(`   ${index + 1}. [${notif.type}] ${notif.title}`);
            console.log(`      Message: ${notif.message}`);
            console.log(`      Read: ${notif.read ? "Yes" : "No"}`);
            console.log(`      Created: ${notif.created_at}\n`);
        });

        console.log("🎉 All tests passed!\n");
        console.log("📋 Next steps:");
        console.log("   1. Login as employee: " + employee.email);
        console.log("   2. Navigate to Notifications tab");
        console.log("   3. Verify all 4 test notifications appear");
        console.log("   4. Test real-time: Have owner create a job/approve request/send payroll/send message");
        console.log("   5. Verify notification appears instantly without refresh\n");

    } catch (err) {
        console.error("❌ Test failed:", err.message);
        console.error(err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

testNotifications();
