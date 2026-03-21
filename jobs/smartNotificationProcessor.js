const cron = require('node-cron');
const { pool } = require("../db");

// We fetch these inside the function to avoid circular dependencies during startup if any
function startSmartNotificationProcessor() {
  console.log("⏰ Starting Smart Notification CRON (Runs every 6 hours)...");
  
  // Runs at minute 0 past every 6th hour (e.g. 00:00, 06:00, 12:00, 18:00)
  cron.schedule('0 */6 * * *', async () => {
    try {
      console.log("🔔 Running scheduled Smart Notifications...");
      const { sendRandomTip, sendRandomPoke, sendSmartNotification } = require("../services/smartNotificationService");
      
      const result = await pool.query(
        "SELECT id, company_id FROM users WHERE push_token IS NOT NULL AND role = 'owner' ORDER BY RANDOM() LIMIT 5"
      );

      for (const user of result.rows) {
        const attendanceCheck = await pool.query(
          "SELECT id FROM attendance WHERE company_id = $1 AND date = CURRENT_DATE LIMIT 1",
          [user.company_id]
        );

        if (attendanceCheck.rows.length === 0) {
          await sendSmartNotification(user.id, user.company_id, {
            title: "📅 Attendance Reminder",
            message: "Attendance hasn't been marked today. Don't forget to check!",
            type: "reminder_attendance",
            priority: "medium",
            data: { url: "/owner/attendance" }
          });
        }

        if (Math.random() > 0.5) {
          await sendRandomTip(user.id, user.company_id);
        } else {
          await sendRandomPoke(user.id, user.company_id);
        }
      }
    } catch (err) {
      console.error("❌ Smart Notification CRON Error:", err.message);
    }
  });
}

module.exports = { startSmartNotificationProcessor };
