const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin
try {
    let serviceAccount;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // If provided via environment variable (useful for production/Render)
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log('📡 Using Firebase credentials from Environment Variable');
    } else {
        // Fallback to local file (for development)
        serviceAccount = require('./firebase-service-account.json');
        console.log('📡 Using Firebase credentials from local JSON file');
    }

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('✅ Firebase Admin initialized successfully');
    }
} catch (error) {
    console.error('❌ Error initializing Firebase Admin:', error.message);
    console.log('💡 TIP: Make sure FIREBASE_SERVICE_ACCOUNT is set in your .env or firebase-service-account.json exists.');
}

/**
 * Send a push notification to a specific device token
 */
async function sendPushNotification(token, title, body, data = {}) {
    if (!token) return;

    const message = {
        notification: {
            title: title,
            body: body,
        },
        data: {
            ...data,
            click_action: 'FLUTTER_NOTIFICATION_CLICK', // Standard for many mobile wrappers
        },
        token: token,
    };

    try {
        const response = await admin.messaging().send(message);
        console.log('✅ Push notification sent successfully:', response);
        return response;
    } catch (error) {
        console.error('❌ Error sending push notification:', error);
        // If token is invalid, we might want to remove it from DB in a real app
        throw error;
    }
}

module.exports = {
    sendPushNotification,
    admin
};
