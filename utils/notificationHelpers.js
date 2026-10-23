const { pool } = require('../db');
const { redisClient } = require('./redis');
const { sendPushNotification } = require('../services/firebaseService');
const { isInternalNotificationRole, isCustomerNotificationTypeAllowed } = require('./notificationAudience');
const { deliverUserEvent, notificationRecipientIdempotencyKey } = require('./notificationDelivery');

// Store active SSE connections: { userId: [response1, response2, ...] }
const sseConnections = new Map();

/**
 * Create a notification in the database and broadcast it via SSE and Push
 */
/**
 * Enhanced createNotification - Supporting Background Queues
 */
async function createNotification(arg1, arg2, arg3, arg4, arg5) {
    let opts = {};
    if (typeof arg1 === 'object' && arg1 !== null) {
        opts = arg1;
    } else {
        // Positional signature: createNotification(userId, type, title, message, url)
        opts = {
            user_id: arg1,
            type: arg2 || 'system',
            title: (typeof arg3 === 'string' && arg4) ? arg3 : 'System Notification',
            message: (typeof arg3 === 'string' && arg4) ? arg4 : (arg3 || 'New notification received'),
            data: { url: (typeof arg5 === 'string' ? arg5 : (typeof arg4 === 'string' && arg4.startsWith('/') ? arg4 : '/notifications')) }
        };
    }

    let { user_id, company_id, type, title, message, priority = 'normal', data = {}, idempotency_key = null, actor_id = null } = opts;

    if (!user_id) {
        console.warn('⚠️ createNotification called without user_id');
        return null;
    }

    // Staff notification rows and their SSE/push payloads are internal-only.
    // Reject customer recipients before any persistence or fan-out.
    const recipientResult = await pool.query(
        'SELECT id, role, company_id FROM users WHERE id::text = $1::text LIMIT 1',
        [String(user_id)]
    );
    const recipient = recipientResult.rows[0];
    if (!recipient || !isInternalNotificationRole(recipient.role)) {
        throw new Error(`Refusing staff notification for non-internal recipient ${user_id}`);
    }
    if (company_id != null && String(recipient.company_id ?? '') !== String(company_id)) {
        throw new Error(`Refusing cross-company notification for recipient ${user_id}`);
    }
    company_id = recipient.company_id;

    // Lookup company_id if omitted
    if (!company_id) {
        try {
            const uRes = await pool.query('SELECT company_id FROM users WHERE id::text = $1', [String(user_id)]);
            if (uRes.rows[0]?.company_id) company_id = uRes.rows[0].company_id;
        } catch {}
    }

    // STRICT RULE: Never notify the same user who performed the action
    if (actor_id && String(actor_id) === String(user_id)) {
        console.log(`🔕 Skipping self-notification for user ${user_id} (actor === receiver)`);
        return null;
    }

    try {
        // Ensure data is an object and has a target URL for 1-click navigation
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { data = { url: data }; }
        }
        if (!data.url) {
            if (type.includes('job')) data.url = '/employee/jobs';
            else if (type.includes('leave') || type.includes('hr') || type.includes('attendance')) data.url = '/hr/requests';
            else if (type.includes('invoice') || type.includes('payment')) data.url = '/owner/finance';
            else if (type.includes('payroll')) data.url = '/employee/payroll';
            else data.url = '/notifications';
        }

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

        // 1. Instant Real-time Web UI Delivery via SSE (<1ms in-process, instant Redis pubsub)
        broadcastToUser(user_id, {
            type: 'notification',
            data: notification
        });

        // 2. Background Processing for Push & External Channels (Non-blocking)
        setImmediate(async () => {
            // Push Notification (Mobile/FCM)
            try {
                const deviceResult = await pool.query(
                    'SELECT fcm_token FROM user_devices WHERE user_id = $1',
                    [user_id]
                );
                const tokens = deviceResult.rows.map(r => r.fcm_token);

                if (tokens.length > 0) {
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
                }
            } catch (pushErr) {
                console.error('❌ Multi-device push failed:', pushErr.message);
            }

            // WhatsApp Notification Channel
            try {
                const { isWhatsAppConfigured, sendWhatsAppTemplateMessage } = require('../services/whatsappService');
                if (isWhatsAppConfigured()) {
                    const uRes = await pool.query('SELECT phone FROM users WHERE id = $1', [user_id]);
                    const phone = uRes.rows[0]?.phone;
                    if (phone) {
                        let templateName = 'job_status_update';
                        if (type.includes('assign')) templateName = 'job_assignment_alert';
                        else if (type.includes('otp')) templateName = 'otp_verification';

                        const components = [{
                            type: 'body',
                            parameters: [{ type: 'text', text: title || 'Notification' }, { type: 'text', text: message || '' }]
                        }];

                        await sendWhatsAppTemplateMessage(phone, templateName, 'en_US', components);
                    }
                }
            } catch (waErr) {
                console.warn('⚠️ WhatsApp dispatch warning:', waErr.message);
            }
        });

        console.log(`✅ Notification created and broadcast to user ${user_id}:`, title);
        return notification;
    } catch (err) {
        console.error('❌ Error creating notification:', err);
        throw err;
    }
}

/** Customer portal activity feed entries (separate from staff notification rows). */
async function createCustomerPortalNotification({ customerId, companyId, type, title, message, jobId, invoiceId = null, url = null }) {
    if (!customerId || !companyId) return null;
    if (!isCustomerNotificationTypeAllowed(type)) {
        throw new Error(`Customer notification type is not allowlisted: ${type}`);
    }
    let job = null;
    if (jobId) {
        const jobResult = await pool.query(
            `SELECT id, customer_id, company_id FROM jobs
             WHERE id::text = $1::text AND customer_id::text = $2::text AND company_id::text = $3::text LIMIT 1`,
            [String(jobId), String(customerId), String(companyId)]
        );
        job = jobResult.rows[0];
        if (!job) throw new Error('Customer notification job does not belong to this customer and company');
    }
    if (invoiceId) {
        const invoiceResult = await pool.query(
            `SELECT i.id, i.job_id, i.customer_id, i.company_id
             FROM invoices i
             WHERE i.id::text = $1::text AND i.customer_id::text = $2::text AND i.company_id::text = $3::text
               AND (i.job_id IS NULL OR EXISTS (
                 SELECT 1 FROM jobs j WHERE j.id = i.job_id AND j.customer_id::text = $2::text
                   AND j.company_id::text = $3::text
               ))
             LIMIT 1`,
            [String(invoiceId), String(customerId), String(companyId)]
        );
        if (!invoiceResult.rows[0]) throw new Error('Customer notification invoice does not belong to this customer and company');
        if (job && String(invoiceResult.rows[0].job_id || '') !== String(job.id)) {
            throw new Error('Customer notification invoice is not associated with the specified job');
        }
    }
    if (!job && !invoiceId) {
        throw new Error('Customer notifications must reference an authorized job or invoice');
    }
    const details = { customer_id: customerId, type, title, message, job_id: jobId || null, invoice_id: invoiceId, url };
    const result = await pool.query(
        `INSERT INTO activities (user_id, action, activity_type, details, company_id, created_at)
         VALUES ($1, $2, 'customer_notification', $3, $4, NOW())
         RETURNING id, action AS type, details, created_at`,
        [customerId, title, JSON.stringify(details), companyId]
    );
    return result.rows[0] || null;
}

/**
 * Broadcast a message to a specific user via SSE.
 * C4 FIX: Uses Redis pub/sub so broadcast works in cluster mode (multi-worker).
 * Falls back to in-process Map only when Redis is unavailable.
 */
function broadcastToUser(userId, message) {
    const uid = String(userId);
    // An SSE connection with Redis enabled is also registered in the local map.
    // Sending locally and publishing the same event delivered it twice to that
    // connection. Redis is the fan-out path when available; use local delivery
    // only when Redis cannot carry the event.
    deliverUserEvent({
        userId: uid,
        message,
        redisClient,
        localBroadcast: _broadcastInProcess,
        onRedisError: (error) => console.error(`❌ Redis broadcast error for user ${uid}:`, error.message),
    });
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
async function createNotificationForCompany({ company_id, type, title, message, priority = 'medium', data = null, exclude_user_id = null, idempotency_key = null }) {
    try {
        if (company_id == null || String(company_id).trim() === '') {
            return { success: true, count: 0 };
        }
        // 1. Fetch all target employee IDs
        let query = "SELECT id FROM users WHERE role = 'employee' AND company_id::text = $1::text";
        let params = [String(company_id)];
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
        const rowValues = [];
        const bulkValues = [];
        employees.forEach((emp, i) => {
            const base = i * (idempotency_key ? 8 : 7);
            rowValues.push(idempotency_key
                ? `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8}, NOW())`
                : `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, NOW())`);
            bulkValues.push(emp.id, company_id, type, title, message, priority, mergedData);
            if (idempotency_key) bulkValues.push(notificationRecipientIdempotencyKey(idempotency_key, emp.id));
        });

        const insertResult = await pool.query(
            `INSERT INTO notifications (user_id, company_id, type, title, message, priority, data${idempotency_key ? ', idempotency_key' : ''}, created_at)
             VALUES ${rowValues.join(', ')}
             ${idempotency_key ? 'ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING' : ''}
             RETURNING id, user_id, type, title, message, priority, data, created_at`,
            bulkValues
        );

        // 3. Broadcast each inserted notification via Redis SSE (non-blocking)
        insertResult.rows.forEach(notification => {
            broadcastToUser(notification.user_id, { type: 'notification', data: notification });
        });

        return { success: true, count: insertResult.rows.length };
    } catch (err) {
        console.error('❌ Error in createNotificationForCompany:', err);
        throw err;
    }
}

/**
 * Create notifications for all owners/admins in a company.
 * Medium FIX: Uses a single bulk INSERT instead of N+1 parallel INSERTs.
 */
async function createNotificationForOwners({ company_id, type, title, message, priority = 'medium', data = null, exclude_user_id = null, idempotency_key = null }) {
    try {
        if (company_id == null || String(company_id).trim() === '') {
            return { success: true, count: 0 };
        }
        // 1. Fetch all target owner/admin IDs
        let query = "SELECT id FROM users WHERE role IN ('owner', 'admin') AND company_id::text = $1::text";
        let params = [String(company_id)];
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
            const base = i * (idempotency_key ? 8 : 7);
            rowValues.push(idempotency_key
                ? `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8}, NOW())`
                : `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, NOW())`);
            bulkValues.push(owner.id, company_id, type, title, message, priority, mergedData);
            if (idempotency_key) bulkValues.push(notificationRecipientIdempotencyKey(idempotency_key, owner.id));
        });

        const insertResult = await pool.query(
            `INSERT INTO notifications (user_id, company_id, type, title, message, priority, data${idempotency_key ? ', idempotency_key' : ''}, created_at)
             VALUES ${rowValues.join(', ')}
             ${idempotency_key ? 'ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING' : ''}
             RETURNING id, user_id, type, title, message, priority, data, created_at`,
            bulkValues
        );

        // 3. Broadcast each notification via Redis SSE (non-blocking)
        insertResult.rows.forEach(notification => {
            broadcastToUser(notification.user_id, { type: 'notification', data: notification });
        });

        return { success: true, count: insertResult.rows.length };
    } catch (err) {
        console.error('❌ Error in createNotificationForOwners:', err);
        throw err;
    }
}

module.exports = {
    createNotification,
    createCustomerPortalNotification,
    createNotificationForCompany,
    createNotificationForOwners,
    broadcastToUser,
    registerSSEConnection,
    unregisterSSEConnection
};
