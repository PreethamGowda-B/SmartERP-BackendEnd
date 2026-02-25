const { createNotification } = require('./utils/notificationHelpers');
const { pool } = require('./db');
require('dotenv').config();

async function sendTestNotification(userId) {
    console.log(`🚀 Sending test notification to user: ${userId}`);

    try {
        // 1. Check if user exists
        const userResult = await pool.query('SELECT id, email, push_token FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            console.error('❌ User not found. Please provide a valid User ID.');
            process.exit(1);
        }

        const user = userResult.rows[0];
        console.log(`👤 Found user: ${user.email}`);
        console.log(`📡 Push Token status: ${user.push_token ? 'Present ✅' : 'Missing ❌'}`);

        // 2. Trigger notification
        await createNotification({
            user_id: user.id,
            company_id: null, // Test notification doesn't need company_id
            type: 'test',
            title: 'Test Notification 🔔',
            message: 'This is a test notification from the SmartERP system! If you see this, real-time toasts and push notifications are working.',
            priority: 'high',
            data: {
                url: '/notifications',
                timestamp: new Date().toISOString()
            }
        });

        console.log('✅ Test notification triggered successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error sending test notification:', err.message);
        process.exit(1);
    }
}

// Get user ID from command line argument
const testUserId = process.argv[2];

if (!testUserId) {
    console.log('Usage: node test-notification.js <USER_ID>');
    console.log('You can find your User ID in the users table or Owner Portal settings.');
    process.exit(1);
}

sendTestNotification(testUserId);
