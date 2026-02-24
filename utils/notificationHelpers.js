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
            // Fetch user's push token from DB
            const userResult = await pool.query('SELECT push_token FROM users WHERE id = $1', [user_id]);
            const pushToken = userResult.rows[0]?.push_token;

            if (pushToken) {
                await sendPushNotification(pushToken, title, message, {
                    type,
                    notificationId: notification.id.toString(),
                    url: `/notifications` // Default redirect
                });
                console.log(`📡 Push notification sent to user ${user_id}`);
            }
        } catch (pushErr) {
            console.error('⚠️ Failed to send push notification:', pushErr.message);
            // Don't throw, we don't want to break the main notification flow
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
 * Get count of active connections for a user
 */
function getConnectionCount(userId) {
    return sseConnections.get(userId)?.length || 0;
}

module.exports = {
    createNotification,
    broadcastToUser,
    registerSSEConnection,
    unregisterSSEConnection,
    getConnectionCount
};
