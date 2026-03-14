const admin = require('firebase-admin');

let firebaseInitialized = false;

// Initialize Firebase Admin — resilient startup
try {
    let serviceAccount;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.log('📡 Found FIREBASE_SERVICE_ACCOUNT env var. Length:', process.env.FIREBASE_SERVICE_ACCOUNT.length);
        // Production: credentials from environment variable
        try {
            let rawData = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
            // Defensive: Remove surrounding single/double quotes if present
            if ((rawData.startsWith("'") && rawData.endsWith("'")) ||
                (rawData.startsWith('"') && rawData.endsWith('"'))) {
                console.log('📝 Removing surrounding quotes from env var');
                rawData = rawData.substring(1, rawData.length - 1);
            }
            serviceAccount = JSON.parse(rawData);
            console.log('✅ FIREBASE_SERVICE_ACCOUNT parsed successfully');
        } catch (parseErr) {
            console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', parseErr.message);
            console.error('📝 First 50 chars of env var:', process.env.FIREBASE_SERVICE_ACCOUNT.substring(0, 50));
        }
    } else {
        console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT env var is NOT set.');
        // Development: fallback to local JSON file
        try {
            serviceAccount = require('./firebase-service-account.json');
            console.log('📡 Using Firebase credentials from local JSON file');
        } catch (fileErr) {
            console.warn('⚠️ firebase-service-account.json not found.');
        }
    }

    if (serviceAccount) {
        console.log('🚀 Initializing Firebase Admin SDK...');
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('✅ Firebase Admin SDK initialized (First App)');
        } else {
            console.log('✅ Firebase Admin SDK already initialized');
        }
        firebaseInitialized = true;
        console.log('⭐ firebaseInitialized set to TRUE');
    } else {
        console.error('❌ No valid Firebase service account found. Push notifications will be DISABLED.');
    }
} catch (error) {
    console.error('❌ CRITICAL Error initializing Firebase Admin:', error.stack);
}

/**
 * Send a push notification to a specific device token.
 * Silently skips if Firebase is not initialized.
 */
async function sendPushNotification(token, title, body, data = {}) {
    if (!token) {
        console.warn('⚠️ Push notification skipped — No token provided.');
        return;
    }
    if (!firebaseInitialized) {
        console.warn('⚠️ Push notification skipped — Firebase not initialized in this process.');
        return;
    }

    console.log(`🚀 FCM: Sending to token ${token.substring(0, 10)}... Title: ${title}`);

    const message = {
        notification: { title, body },
        data: Object.fromEntries(
            // FCM data payload values must ALL be strings
            Object.entries({ ...data, title, body }).map(([k, v]) => [k, String(v ?? '')])
        ),
        android: {
            priority: 'high', // Deliver immediately even in Doze mode
            notification: {
                channel_id: 'fcm_default_channel',
                priority: 'high',
                sound: 'default',
                default_sound: true,
                default_vibrate_timings: true,
                notification_priority: 'PRIORITY_MAX',
                visibility: 'public'
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
        console.log('✅ Push notification sent successfully:', response);
        return response;
    } catch (error) {
        console.error('❌ Error sending push notification:', error);
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
                channel_id: 'fcm_default_channel',
                priority: 'high',
                sound: 'default'
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
            headers: { 'apns-priority': '10' },
            payload: { aps: { sound: 'default', 'content-available': 1 } },
        },
        tokens,
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(payload);
        console.log(`✅ Multicast push sent: ${response.successCount} success, ${response.failureCount} failure`);
        
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
        console.error('❌ Error sending multicast notification:', error);
        throw error;
    }
}

module.exports = { sendPushNotification, sendMulticastPush, admin };
