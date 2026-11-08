const admin = require('firebase-admin');
const logger = require('../utils/logger');

let firebaseInitialized = false;

// Initialize Firebase Admin — resilient startup
try {
    let serviceAccount;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            let rawData = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
            // Defensive: Remove surrounding single/double quotes if present
            if ((rawData.startsWith("'") && rawData.endsWith("'")) ||
                (rawData.startsWith('"') && rawData.endsWith('"'))) {
                rawData = rawData.substring(1, rawData.length - 1);
            }
            serviceAccount = JSON.parse(rawData);
        } catch (parseErr) {
            logger.error('Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable', parseErr);
        }
    } else {
        // Development: fallback to local JSON file
        try {
            serviceAccount = require('./firebase-service-account.json');
            logger.debug('Using Firebase credentials from local JSON file', { pid: process.pid });
        } catch (_) {
            logger.debug('firebase-service-account.json not found', { pid: process.pid });
        }
    }

    if (serviceAccount) {
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            logger.info('Firebase Admin initialized', { pid: process.pid, isFirstApp: true });
        } else {
            logger.debug('Firebase Admin already initialized in app registry', { pid: process.pid });
        }
        firebaseInitialized = true;
    } else {
        logger.warn('No valid Firebase service account found. Push notifications will be disabled.', { pid: process.pid });
    }
} catch (error) {
    logger.error('Critical error initializing Firebase Admin', error, { pid: process.pid });
}

/**
 * Send a push notification to a specific device token.
 * Silently skips if Firebase is not initialized.
 */
async function sendPushNotification(token, title, body, data = {}) {
    if (!token) {
        logger.debug('Push notification skipped — no token provided');
        return;
    }
    if (!firebaseInitialized) {
        logger.debug('Push notification skipped — Firebase not initialized');
        return;
    }

    const message = {
        notification: { title, body },
        data: Object.fromEntries(
            // FCM data payload values must ALL be strings
            Object.entries({ ...data, title, body }).map(([k, v]) => [k, String(v ?? '')])
        ),
        android: {
            priority: 'high',
            notification: {
                sound: 'default',
                channelId: 'fcm_default_channel'
            },
        },
        webpush: {
            headers: {
                Urgency: 'high'
            },
            notification: {
                title,
                body,
                icon: '/icon.png',
                badge: '/icon.png',
                tag: 'smarterp-notification',
                renotify: true,
                requireInteraction: true,
                vibrate: [200, 100, 200]
            },
            fcm_options: {
                link: data?.url || '/'
            }
        },
        apns: {
            headers: { 'apns-priority': '10' },
            payload: { aps: { sound: 'default', 'content-available': 1 } },
        },
        token,
    };

    try {
        const response = await admin.messaging().send(message);
        logger.debug('Push notification delivered', { messageId: response });
        logger.business('NOTIFICATION_SENT', { channel: 'fcm_push', count: 1, title });
        return response;
    } catch (error) {
        logger.error('Error sending push notification', error, { title });
        throw error;
    }
}

/**
 * Send a push notification to multiple device tokens.
 */
async function sendMulticastPush(tokens, title, body, data = {}) {
    if (!tokens || tokens.length === 0) return;
    if (!firebaseInitialized) return;

    const payload = {
        notification: { title, body },
        data: Object.fromEntries(
            Object.entries({ ...data, title, body }).map(([k, v]) => [k, String(v ?? '')])
        ),
        android: {
            priority: 'high',
            notification: {
                title,
                body,
                sound: 'default',
                channelId: 'fcm_default_channel',
                icon: 'ic_launcher'
            },
        },
        webpush: {
            headers: {
                Urgency: 'high'
            },
            notification: {
                title,
                body,
                icon: '/icon.png',
                badge: '/icon.png',
                tag: 'smarterp-notification',
                renotify: true,
                requireInteraction: true
            },
            fcm_options: {
                link: data?.url || '/'
            }
        },
        apns: {
            headers: { 
                'apns-priority': '10',
                'apns-push-type': 'alert'
            },
            payload: { 
                aps: { 
                    alert: { title, body },
                    sound: 'default', 
                    'content-available': 1,
                    badge: 1
                } 
            },
        },
        tokens,
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(payload);
        logger.debug('Multicast push delivered', { successCount: response.successCount, failureCount: response.failureCount });
        logger.business('NOTIFICATION_SENT', { channel: 'fcm_multicast', successCount: response.successCount, failureCount: response.failureCount, title });

        // Return tokens that failed so we can clean them up if needed
        const failedTokens = [];
        if (response.failureCount > 0) {
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    failedTokens.push(tokens[idx]);
                }
            });
        }
        return { response, failedTokens };
    } catch (error) {
        logger.error('Error sending multicast notification', error, { title });
        throw error;
    }
}

module.exports = { sendPushNotification, sendMulticastPush, admin };
