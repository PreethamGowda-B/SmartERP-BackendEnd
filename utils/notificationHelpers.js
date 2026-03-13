const { pool } = require('../db');
const { sendPushNotification } = require('../services/firebaseService');

// Store active SSE connections: { userId: [response1, response2, ...] }
const sseConnections = new Map();

/**
 * Create a notification in the database and broadcast it via SSE and Push
 */
async function createNotification({ user_id, company_id, type, title, message, priority = 'medium', data = null }) {
    try {
        const result = await pool.query(
            `INSERT INTO notifications (user_id, company_id, type, title, message, priority, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
            [user_id, company_id, type, title, message, priority, data ? JSON.stringify(data) : null]
        );

        const notification = result.rows[0];

        // 1. Broadcast to user via SSE (Real-time Web UI)
        broadcastToUser(user_id, {
            type: 'notification',
            data: notification
        });

        // 2. Send Push Notification (Real-time Background/Mobile)
        try {
            console.log(`📡 Attempting push for user ${user_id} (Type: ${type})`);
            // Fetch user's push token from DB
            const userResult = await pool.query('SELECT push_token FROM users WHERE id = $1', [user_id]);
            const pushToken = userResult.rows[0]?.push_token;

            if (pushToken) {
                console.log(`✅ Found push token for user ${user_id}: ${pushToken.substring(0, 10)}...`);

                // Determine the best URL fallback if not provided
                let finalUrl = data?.url;
                if (!finalUrl) {
                    // Smart defaults based on notification type
                    if (type.startsWith('job')) {
                        finalUrl = '/notifications'; // Will be refined by broad functions
                    } else if (type.startsWith('attendance') || type.startsWith('employee_clock')) {
                        finalUrl = '/attendance';
                    } else if (type.startsWith('material_request')) {
                        finalUrl = '/inventory';
                    } else if (type.startsWith('payroll')) {
                        finalUrl = '/payroll';
                    } else if (type === 'message') {
                        finalUrl = '/messages';
                    } else {
                        finalUrl = '/notifications';
                    }
                }

                // Append role prefix if we can determine it
                // Note: broad functions like createNotificationForCompany already set the role prefix
                
                const pushData = {
                    type,
                    notificationId: notification.id.toString(),
                    url: finalUrl,
                    ...data
                };

                const success = await sendPushNotification(pushToken, title, message, pushData);
                if (success) {
                    console.log(`✅ Push notification sent successfully to user ${user_id}`);
                }
            } else {
                console.log(`⚠️ No push token found for user ${user_id}. Skipping push.`);
            }
        } catch (pushErr) {
            console.error('❌ Failed to send push notification during createNotification:', pushErr.message);
        }

        console.log(`✅ Notification created and broadcast to user ${user_id}:`, title);
        return notification;
    } catch (err) {
        console.error('❌ Error creating notification:', err);
        throw err;
    }
}

/**
 * Broadcast a message to a specific user via SSE
 */
function broadcastToUser(userId, message) {
    const connections = sseConnections.get(userId);
    if (connections && connections.length > 0) {
        const messageStr = `data: ${JSON.stringify(message)}\n\n`;
        connections.forEach((res, index) => {
            try {
                res.write(messageStr);
                console.log(`📡 Broadcast to user ${userId} connection #${index + 1}`);
            } catch (err) {
                console.error(`❌ Failed to broadcast to connection #${index + 1}:`, err.message);
                // Remove dead connection
                connections.splice(index, 1);
            }
        });
    } else {
        console.log(`ℹ️  No active SSE connections for user ${userId}`);
    }
}

/**
 * Register a new SSE connection for a user
 */
function registerSSEConnection(userId, response) {
    if (!sseConnections.has(userId)) {
        sseConnections.set(userId, []);
    }
    sseConnections.get(userId).push(response);
    console.log(`✅ SSE connection registered for user ${userId}. Total connections: ${sseConnections.get(userId).length}`);
}

/**
 * Unregister an SSE connection for a user
 */
function unregisterSSEConnection(userId, response) {
    const connections = sseConnections.get(userId);
    if (connections) {
        const index = connections.indexOf(response);
        if (index > -1) {
            connections.splice(index, 1);
            console.log(`✅ SSE connection unregistered for user ${userId}. Remaining: ${connections.length}`);
        }
        if (connections.length === 0) {
            sseConnections.delete(userId);
        }
    }
}

/**
 * Create notifications for all employees in a company
 */
async function createNotificationForCompany({ company_id, type, title, message, priority = 'medium', data = null, exclude_user_id = null }) {
    try {
        // 1. Fetch all employees for the company
        // Use ::text casting to be type-agnostic (handles both Integer and UUID company_ids)
        let query = "SELECT id FROM users WHERE role = 'employee'";
        let params = [];

        if (company_id) {
            const cid = String(company_id);
            if (cid !== '1' && cid !== '0' && cid !== '00000000-0000-0000-0000-000000000000') {
                query += " AND (company_id::text = $1 OR company_id::text = '1' OR company_id IS NULL)";
                params.push(cid);
            } else {
                query += " AND (company_id::text = '1' OR company_id IS NULL)";
            }
        }

        if (exclude_user_id) {
            query += ` AND id::text != $${params.length + 1}::text`;
            params.push(String(exclude_user_id));
        }

        const employeesResult = await pool.query(query, params);
        const employees = employeesResult.rows;

        console.log(`📣 Broadcasting notification to ${employees.length} employees for company ${company_id || 'Global'}`);

        // 2. Create notifications for each (Parallel)
        const notificationPromises = employees.map(emp =>
            createNotification({
                user_id: emp.id,
                company_id,
                type,
                title,
                message,
                priority,
                data: { url: '/employee/notifications', ...data }
            }).catch(err => console.error(`❌ Failed to notify employee ${emp.id}:`, err.message))
        );

        await Promise.all(notificationPromises);
        return { success: true, count: employees.length };
    } catch (err) {
        console.error('❌ Error in createNotificationForCompany:', err);
        throw err;
    }
}

/**
 * Create notifications for all owners/admins in a company
 */
async function createNotificationForOwners({ company_id, type, title, message, priority = 'medium', data = null, exclude_user_id = null }) {
    try {
        // 1. Fetch all owners and admins for the company
        // Use ::text casting to be type-agnostic (handles both Integer and UUID company_ids)
        let query = "SELECT id FROM users WHERE role IN ('owner', 'admin')";
        let params = [];

        if (company_id) {
            const cid = String(company_id);
            const isDefault = cid === '1' || cid === '0' || cid === '00000000-0000-0000-0000-000000000000';
            
            if (!isDefault) {
                query += " AND (company_id::text = $1 OR company_id::text = '1' OR company_id IS NULL)";
                params.push(cid);
            } else {
                query += " AND (company_id::text = '1' OR company_id IS NULL)";
            }
        }

        if (exclude_user_id) {
            query += ` AND id::text != $${params.length + 1}::text`;
            params.push(String(exclude_user_id));
        }

        const ownersResult = await pool.query(query, params);
        const owners = ownersResult.rows;

        console.log(`📣 Broadcasting notification to ${owners.length} owners/admins for company ${company_id || 'Global'}`);

        // 2. Create notifications for each (Parallel)
        const notificationPromises = owners.map(owner =>
            createNotification({
                user_id: owner.id,
                company_id,
                type,
                title,
                message,
                priority,
                data: { url: '/owner/notifications', ...data }
            }).catch(err => console.error(`❌ Failed to notify owner ${owner.id}:`, err.message))
        );

        await Promise.all(notificationPromises);
        return { success: true, count: owners.length };
    } catch (err) {
        console.error('❌ Error in createNotificationForOwners:', err);
        throw err;
    }
}

module.exports = {
    createNotification,
    createNotificationForCompany,
    createNotificationForOwners,
    broadcastToUser,
    registerSSEConnection,
    unregisterSSEConnection
};
