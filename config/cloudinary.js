const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Check if Cloudinary credentials are set
const hasCloudinaryConfig = !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

if (!hasCloudinaryConfig) {
    console.warn('⚠️  Cloudinary credentials not found. Image uploads will be disabled.');
    console.warn('   Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET');
}

// Configure Cloudinary
if (hasCloudinaryConfig) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
    console.log('✅ Cloudinary configured successfully');
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
