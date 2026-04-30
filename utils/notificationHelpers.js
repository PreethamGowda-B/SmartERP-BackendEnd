const { pool } = require('../db');
const redisPublisher = require('./redis');
const { sendPushNotification } = require('../services/firebaseService');

// Store active SSE connections: { userId: [response1, response2, ...] }
const sseConnections = new Map();

/**
 * Create a notification in the database and broadcast it via SSE and Push
 */
/**
 * Enhanced createNotification - Supporting Background Queues
 */
async function createNotification(notificationData) {
    const { user_id, company_id, type, title, message, priority = 'low', data = {}, idempotency_key = null, actor_id = null } = notificationData;

    // STRICT RULE: Never notify the same user who performed the action
    if (actor_id && String(actor_id) === String(user_id)) {
        console.log(`🔕 Skipping self-notification for user ${user_id} (actor === receiver)`);
        return null;
    }

    try {
        // If idempotency_key provided, use ON CONFLICT DO NOTHING to deduplicate
        let result;
        if (idempotency_key) {
            result = await pool.query(
                `INSERT INTO notifications (user_id, company_id, type, title, message, priority, data, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING *`,
                [user_id, company_id, type, title, message, priority, JSON.stringify(data), idempotency_key]
            );
            if (result.rows.length === 0) {
                console.log(`🔁 Duplicate notification suppressed: key=${idempotency_key}`);
                return null; // Already created — deduplicated
            }
        } else {
            result = await pool.query(
                `INSERT INTO notifications (user_id, company_id, type, title, message, priority, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING *`,
                [user_id, company_id, type, title, message, priority, JSON.stringify(data)]
            );
        }

        const notification = result.rows[0];

        // 1. Broadcast to user via SSE (Real-time Web UI)
        broadcastToUser(user_id, {
            type: 'notification',
            data: notification
        });

        // 2. Send Push Notification (Real-time Background/Mobile)
        try {
            // Fetch all active devices for this user
            const deviceResult = await pool.query(
                'SELECT fcm_token FROM user_devices WHERE user_id = $1',
                [user_id]
            );
            const tokens = deviceResult.rows.map(r => r.fcm_token);

            if (tokens.length > 0) {
                console.log(`📡 Attempting multicast push for user ${user_id} to ${tokens.length} devices`);

                let finalUrl = data?.url;
                if (!finalUrl) {
                    if (type.startsWith('job')) finalUrl = '/notifications';
                    else if (type.startsWith('attendance')) finalUrl = '/attendance';
                    else if (type.startsWith('material_request')) finalUrl = '/inventory';
                    else if (type.startsWith('payroll')) finalUrl = '/payroll';
                    else finalUrl = '/notifications';
                }

                const pushData = {
                    type,
                    notificationId: notification.id.toString(),
                    url: finalUrl,
                    ...data
                };

                const { sendMulticastPush } = require('../services/firebaseService');
                await sendMulticastPush(tokens, title, message, pushData);
                console.log(`✅ Multi-device push sent successfully to user ${user_id}`);
            } else {
                console.log(`⚠️ No registered devices for user ${user_id}. Skipping push.`);
            }
        } catch (pushErr) {
            console.error('❌ Multi-device push failed:', pushErr.message);
        }

        console.log(`✅ Notification created and broadcast to user ${user_id}:`, title);
        return notification;
    } catch (err) {
        console.error('❌ Error creating notification:', err);
        throw err;
    }
}

/**
 * Broadcast a message to a specific user via SSE.
 * C4 FIX: Uses Redis pub/sub so broadcast works in cluster mode (multi-worker).
 * Falls back to in-process Map only when Redis is unavailable.
 */
function broadcastToUser(userId, message) {
    const uid = String(userId);
    // Primary: Redis pub/sub (cluster-safe)
    if (redisPublisher && redisPublisher.status === 'ready') {
        redisPublisher.publish(`employee_notifications:${uid}`, JSON.stringify(message))
            .catch(e => {
                console.error(`❌ Redis broadcast error for user ${uid}:`, e.message);
                // Fallback to in-process on Redis failure
                _broadcastInProcess(uid, message);
            });
        return;
    }
    // Fallback: in-process Map (single-worker only)
    _broadcastInProcess(uid, message);
}

function _broadcastInProcess(userId, message) {
    const connections = sseConnections.get(userId);
    if (connections && connections.length > 0) {
        const messageStr = `data: ${JSON.stringify(message)}\n\n`;
        connections.forEach((res, index) => {
            try {
                res.write(messageStr);
                console.log(`📡 In-process broadcast to user ${userId} connection #${index + 1}`);
            } catch (err) {
                console.error(`❌ Failed to broadcast to connection #${index + 1}:`, err.message);
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
 * Create notifications for all employees in a company.
 * Medium FIX: Uses a single bulk INSERT instead of N+1 parallel INSERTs.
 * Then broadcasts to each user via Redis pub/sub for real-time delivery.
 */
async function createNotificationForCompany({ company_id, type, title, message, priority = 'medium', data = null, exclude_user_id = null }) {
    try {
        // 1. Fetch all target employee IDs
        let query = "SELECT id FROM users WHERE role = 'employee'";
        let params = [];

        if (company_id) {
            const cid = String(company_id);
            const isDefault = cid === '1' || cid === '0' || cid === '00000000-0000-0000-0000-000000000000';
            if (!isDefault) {
                query += " AND company_id::text = $1";
                params.push(cid);
            } else {
                query += " AND (company_id::text = '1' OR company_id::text = '0' OR company_id IS NULL)";
            }
        }
        if (exclude_user_id) {
            query += ` AND id::text != $${params.length + 1}::text`;
            params.push(String(exclude_user_id));
        }

        const employeesResult = await pool.query(query, params);
        const employees = employeesResult.rows;
        if (employees.length === 0) return { success: true, count: 0 };

        console.log(`📣 Bulk-notifying ${employees.length} employees for company ${company_id || 'Global'}`);

        // 2. Bulk INSERT — single query instead of N individual INSERTs
        const mergedData = JSON.stringify({ url: '/employee/notifications', ...data });
        const valuePlaceholders = employees.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}, NOW())`).join(', ');
        const bulkParams = employees.flatMap(emp => [emp.id, company_id, type, title, message]);
        // We use a per-row subselect to embed priority and data since flatMap would bloat params
        // Instead use a simpler approach: build rows individually in a VALUES list
        const rowValues = [];
        const bulkValues = [];
        employees.forEach((emp, i) => {
            const base = i * 7;
            rowValues.push(`($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, NOW())`);
            bulkValues.push(emp.id, company_id, type, title, message, priority, mergedData);
        });

        const insertResult = await pool.query(
            `INSERT INTO notifications (user_id, company_id, type, title, message, priority, data, created_at)
             VALUES ${rowValues.join(', ')}
             RETURNING id, user_id, type, title, message, priority, data, created_at`,
            bulkValues
        );

        // 3. Broadcast each inserted notification via Redis SSE (non-blocking)
        insertResult.rows.forEach(notification => {
            broadcastToUser(notification.user_id, { type: 'notification', data: notification });
        });

        return { success: true, count: employees.length };
    } catch (err) {
        console.error('❌ Error in createNotificationForCompany:', err);
        throw err;
    }
}

/**
 * Create notifications for all owners/admins in a company.
 * Medium FIX: Uses a single bulk INSERT instead of N+1 parallel INSERTs.
 */
async function createNotificationForOwners({ company_id, type, title, message, priority = 'medium', data = null, exclude_user_id = null }) {
    try {
        // 1. Fetch all target owner/admin IDs
        let query = "SELECT id FROM users WHERE role IN ('owner', 'admin')";
        let params = [];

        if (company_id) {
            const cid = String(company_id);
            const isDefault = cid === '1' || cid === '0' || cid === '00000000-0000-0000-0000-000000000000';
            if (!isDefault) {
                query += " AND company_id::text = $1";
                params.push(cid);
            } else {
                query += " AND (company_id::text = '1' OR company_id::text = '0' OR company_id IS NULL)";
            }
        }
        if (exclude_user_id) {
            query += ` AND id::text != $${params.length + 1}::text`;
            params.push(String(exclude_user_id));
        }

        const ownersResult = await pool.query(query, params);
        const owners = ownersResult.rows;
        if (owners.length === 0) return { success: true, count: 0 };

        console.log(`📣 Bulk-notifying ${owners.length} owners/admins for company ${company_id || 'Global'}`);

        // 2. Bulk INSERT
        const mergedData = JSON.stringify({ url: '/owner/notifications', ...data });
        const rowValues = [];
        const bulkValues = [];
        owners.forEach((owner, i) => {
            const base = i * 7;
            rowValues.push(`($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, NOW())`);
            bulkValues.push(owner.id, company_id, type, title, message, priority, mergedData);
        });

        const insertResult = await pool.query(
            `INSERT INTO notifications (user_id, company_id, type, title, message, priority, data, created_at)
             VALUES ${rowValues.join(', ')}
             RETURNING id, user_id, type, title, message, priority, data, created_at`,
            bulkValues
        );

        // 3. Broadcast each notification via Redis SSE (non-blocking)
        insertResult.rows.forEach(notification => {
            broadcastToUser(notification.user_id, { type: 'notification', data: notification });
        });

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
