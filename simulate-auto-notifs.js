const { createNotification, createNotificationForCompany } = require('./utils/notificationHelpers');
const { pool } = require('./db');
require('dotenv').config();

async function simulate() {
    const ownerId = '47926718-88e2-4010-bca7-aa54ea84b42d';
    const employeeId = 'ea982937-d4f8-4e44-857c-4f0f5d4addfc';
    const companyId = 'c127ddf4-29ed-4c8a-b42d-2317140e6912';

    console.log('--- Simulating 1: New Job Broadcast ---');
    // This is what happens in jobs.js POST /
    try {
        await createNotificationForCompany({
            company_id: companyId,
            type: 'job',
            title: 'Simulation: New Job Available',
            message: 'A new job is available for everyone: Simulation',
            priority: 'medium',
            data: { job_id: 'sim-job-id', job_title: 'Simulation' },
            exclude_user_id: ownerId
        });
    } catch (e) {
        console.error('Error in simulation 1:', e);
    }

    console.log('\n--- Simulating 2: Job Acceptance (Owner Notification) ---');
    // This is what happens in jobs.js POST /:id/accept
    try {
        await createNotification({
            user_id: ownerId, // Notify the owner
            company_id: companyId,
            type: 'job_accepted',
            title: 'Simulation: Job Accepted',
            message: 'Employee accepted the job: Simulation',
            priority: 'medium',
            data: { job_id: 'sim-job-id', employee_id: employeeId }
        });
    } catch (e) {
        console.error('Error in simulation 2:', e);
    }

    process.exit(0);
}

simulate();
