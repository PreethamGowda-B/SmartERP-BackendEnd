require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Never ship Cloudinary credentials in source. Missing configuration disables
// remote image uploads until the deployment environment supplies all values.
const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const apiKey = (process.env.CLOUDINARY_API_KEY || '').trim();
const apiSecret = (process.env.CLOUDINARY_API_SECRET || '').trim();

const hasCloudinaryConfig = !!(cloudName && apiKey && apiSecret);

if (!hasCloudinaryConfig) {
    console.warn('⚠️  Cloudinary credentials not found. Image uploads will be disabled.');
} else {
    cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret
    });
    console.log(`✅ Cloudinary configured successfully for [${cloudName}]`);
}

// Configure Cloudinary storage for multer
let storage = null;
if (hasCloudinaryConfig) {
    try {
        storage = new CloudinaryStorage({
            cloudinary: cloudinary,
            params: {
                folder: 'smarterp/inventory',
                allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
                transformation: [{ width: 800, height: 800, crop: 'limit' }]
            }
        });
    } catch (error) {
        console.error('❌ Error configuring Cloudinary storage:', error.message);
    }
}

module.exports = { cloudinary, storage, hasCloudinaryConfig };
