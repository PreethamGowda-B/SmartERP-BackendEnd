const { createNotification } = require('./utils/notificationHelpers');
require('dotenv').config();

async function testOwnerNotification() {
    const ownerId = '47926718-88e2-4010-bca7-aa54ea84b42d'; // ID for thepreethu01@gmail.com
    console.log(`🚀 Sending test notification to owner: ${ownerId}`);

    try {
        await createNotification({
            user_id: ownerId,
            company_id: null,
            type: 'job_accepted',
            title: 'Job Accepted Notification Test',
            message: 'Manual test of job acceptance notification. If you see this, owner notifications are working!',
            priority: 'high',
            data: {
                job_id: 'test-job-id',
                url: '/jobs'
            }
        });
        console.log('✅ Notification sent to owner.');
    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        process.exit(0);
    }
}

testOwnerNotification();
