const admin = require('firebase-admin');

let firebaseInitialized = false;

// Initialize Firebase Admin — resilient startup
try {
    let serviceAccount;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Production: credentials from environment variable
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log('📡 Using Firebase credentials from Environment Variable');
    } else {
        // Development: fallback to local JSON file
        try {
            serviceAccount = require('./firebase-service-account.json');
            console.log('📡 Using Firebase credentials from local JSON file');
        } catch (fileErr) {
            console.warn('⚠️  firebase-service-account.json not found and FIREBASE_SERVICE_ACCOUNT env var not set.');
            console.warn('⚠️  Push notifications will be DISABLED. Set FIREBASE_SERVICE_ACCOUNT in Render to enable them.');
            // Do NOT throw — allow server to start without Firebase
        }
    }

    if (serviceAccount) {
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        firebaseInitialized = true;
        console.log('✅ Firebase Admin initialized successfully');
    }
} catch (error) {
    console.error('❌ Error initializing Firebase Admin:', error.message);
    console.warn('⚠️  Push notifications will be DISABLED. Set FIREBASE_SERVICE_ACCOUNT in Render to enable them.');
    // Server continues without Firebase
}

/**
 * Send a push notification to a specific device token.
 * Silently skips if Firebase is not initialized.
 */
async function sendPushNotification(token, title, body, data = {}) {
    if (!token) return;
    if (!firebaseInitialized) {
        console.warn('⚠️  Push notification skipped — Firebase not initialized.');
        return;
    }

    const message = {
        notification: { title, body },
        data: {
            ...data,
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
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

module.exports = { sendPushNotification, admin };
