const { pool } = require('../db');
const { createNotification } = require('../utils/notificationHelpers');

async function sendTestNotification() {
    try {
        // Get the first user (likely the one testing)
        const userRes = await pool.query('SELECT id, company_id, email FROM users LIMIT 1');

        if (userRes.rows.length === 0) {
            console.log('❌ No users found to test with');
            process.exit(1);
        }

        const user = userRes.rows[0];
        const companyId = user.company_id || '00000000-0000-0000-0000-000000000000';
        console.log(`👤 Sending test notification to: ${user.email} (${user.id})`);

        await createNotification({
            user_id: user.id,
            company_id: companyId,
            type: 'message',
            title: 'Test Notification',
            message: 'This is a test notification to verify the system is working. 🔔',
            priority: 'medium'
        });

        console.log('✅ Test notification sent successfully!');
    } catch (err) {
        console.error('❌ Error sending test notification:', err);
    } finally {
        await pool.end();
    }
}

sendTestNotification();
