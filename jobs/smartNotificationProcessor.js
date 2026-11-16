const cron = require('node-cron');
const NotificationRoutingService = require('../services/notificationRoutingService');
const { runWithPostgresAdvisoryLock } = require('../utils/scheduledTaskLock');
let notificationTask = null;

function startSmartNotificationProcessor() {
  if (notificationTask) return;
  console.log("⏰ Starting Scheduled Smart Notification Processor...");

  // Runs Monday through Saturday at 10:00 AM IST (04:30 UTC)
  // Sends a single, idempotent attendance reminder strictly to employees who have not marked attendance.
  // NEVER sends reminders or fake tips/pokes to owners.
  notificationTask = cron.schedule('30 4 * * 1-6', async () => {
    await runWithPostgresAdvisoryLock('daily-smart-notifications', async () => {
      try {
        console.log("🔔 [SmartNotificationProcessor] Running morning employee attendance check...");
        await NotificationRoutingService.dispatchDailyAttendanceReminders();
      } catch (err) {
        console.error("❌ Smart Notification CRON Error:", err.message);
        throw err;
      }
    });
  });
}

function stopSmartNotificationProcessor() {
  notificationTask?.stop();
  notificationTask = null;
}

module.exports = { startSmartNotificationProcessor, stopSmartNotificationProcessor };
