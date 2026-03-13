const { createNotification } = require('../utils/notificationHelpers');
const { pool } = require('../db');

/**
 * SmartNotificationService
 * Handles humorous pokes, feature tips, and action-based engagement notifications.
 */

const TIPS = [
    {
        title: "🚀 SmartERP Tip",
        message: "Did you know you can generate payroll in just 2 clicks? Try it today!",
        type: "tip_payroll",
        feature: "payroll"
    },
    {
        title: "📊 SmartERP Reminder",
        message: "Keep your inventory updated to avoid stock surprises.",
        type: "tip_inventory",
        feature: "inventory"
    },
    {
        title: "🧠 SmartERP AI",
        message: "SmartERP AI is ready to help! Ask it anything about managing your company.",
        type: "tip_ai",
        feature: "ai_assistant"
    }
];

const FUN_MESSAGES = [
    {
        title: "🤖 SmartERP AI",
        message: "SmartERP AI says hello! Need help managing your team today?",
        type: "fun_ai"
    },
    {
        title: "📈 Growth Mindset",
        message: "Your business deserves a promotion! Try exploring SmartERP reports today.",
        type: "fun_growth"
    },
    {
        title: "👀 Just Checking In",
        message: "We noticed you haven't checked attendance today. Your employees might be watching!",
        type: "fun_attendance"
    }
];

/**
 * Send a smart notification to a user with frequency control
 */
async function sendSmartNotification(userId, companyId, { title, message, type, priority = 'low', data = {} }) {
    try {
        // Frequency Control: Check if user received a smart notification in the last 12 hours
        const recentCheck = await pool.query(
            `SELECT id FROM notifications 
             WHERE user_id = $1 
             AND type LIKE 'smart_%'
             AND created_at > NOW() - INTERVAL '12 hours'
             LIMIT 1`,
            [userId]
        );

        if (recentCheck.rows.length > 0) {
            console.log(`⏭️ Skipping smart notification for user ${userId} (Frequency Limit reached)`);
            return null;
        }

        // Create the notification (this automatically triggers FCM if token exists)
        return await createNotification({
            user_id: userId,
            company_id: companyId,
            type: `smart_${type}`,
            title,
            message,
            priority,
            data
        });
    } catch (err) {
        console.error('❌ Error in sendSmartNotification:', err.message);
    }
}

/**
 * Triggered when a new employee is added
 */
async function notifyEmployeeAdded(ownerId, companyId, employeeName) {
    return await createNotification({
        user_id: ownerId,
        company_id: companyId,
        type: 'action_employee_added',
        title: "🎉 Team is Growing!",
        message: `Nice! You just added ${employeeName}. Your team is getting stronger!`,
        priority: 'medium',
        data: { url: '/owner/employees' }
    });
}

/**
 * Triggered when payroll is generated
 */
async function notifyPayrollGenerated(ownerId, companyId) {
    return await createNotification({
        user_id: ownerId,
        company_id: companyId,
        type: 'action_payroll',
        title: "🧾 Payroll Processed",
        message: "Payroll processed successfully. Your employees will be happy today!",
        priority: 'medium',
        data: { url: '/owner/payroll' }
    });
}

/**
 * Triggered when a company upgrades its plan
 */
async function notifyPlanUpgrade(ownerId, companyId, newPlanName) {
    return await createNotification({
        user_id: ownerId,
        company_id: companyId,
        type: 'action_upgrade',
        title: "🚀 Level Up!",
        message: `Congratulations! Your company just unlocked ${newPlanName} features. Time to explore!`,
        priority: 'high',
        data: { url: '/owner/billing' }
    });
}

/**
 * Send a random tip to a user
 */
async function sendRandomTip(userId, companyId) {
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
    return await sendSmartNotification(userId, companyId, {
        title: tip.title,
        message: tip.message,
        type: tip.type,
        data: { feature: tip.feature }
    });
}

/**
 * Send a random funny poke
 */
async function sendRandomPoke(userId, companyId) {
    const poke = FUN_MESSAGES[Math.floor(Math.random() * FUN_MESSAGES.length)];
    return await sendSmartNotification(userId, companyId, {
        title: poke.title,
        message: poke.message,
        type: poke.type
    });
}

module.exports = {
    sendSmartNotification,
    notifyEmployeeAdded,
    notifyPayrollGenerated,
    notifyPlanUpgrade,
    sendRandomTip,
    sendRandomPoke
};
