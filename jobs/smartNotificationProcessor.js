const cron = require('node-cron');
const NotificationRoutingService = require('../services/notificationRoutingService');

function startSmartNotificationProcessor() {
  console.log("⏰ Starting Scheduled Smart Notification Processor...");

  // Runs Monday through Saturday at 10:00 AM IST (04:30 UTC)
  // Sends a single, idempotent attendance reminder strictly to employees who have not marked attendance.
  // NEVER sends reminders or fake tips/pokes to owners.
  cron.schedule('30 4 * * 1-6', async () => {
    try {
      console.log("🔔 [SmartNotificationProcessor] Running morning employee attendance check...");
      await NotificationRoutingService.dispatchDailyAttendanceReminders();
    } catch (err) {
      console.error("❌ Smart Notification CRON Error:", err.message);
    }
  });
}

module.exports = { startSmartNotificationProcessor };
