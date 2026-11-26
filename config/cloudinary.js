require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const logger = require('../utils/logger');

// Never ship Cloudinary credentials in source. Missing configuration disables
// remote image uploads until the deployment environment supplies all values.
const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const apiKey = (process.env.CLOUDINARY_API_KEY || '').trim();
const apiSecret = (process.env.CLOUDINARY_API_SECRET || '').trim();

const hasCloudinaryConfig = !!(cloudName && apiKey && apiSecret);

if (!hasCloudinaryConfig) {
    logger.warn('Cloudinary credentials not found. Image uploads will be disabled.', { pid: process.pid });
} else {
    cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret
    });
    logger.info(`Cloudinary storage configured for [${cloudName}]`, { cloudName, pid: process.pid });
}

// Legacy multer-storage-cloudinary removed (all routes use cloudinary.uploader.upload_stream).
const storage = null;

/**
 * Safely delete an asset from Cloudinary by extracting its public_id from its secure URL.
 * Attempts raw and image resource types, and returns true if deleted or already gone.
 */
async function deleteCloudinaryAsset(fileUrl) {
    if (!hasCloudinaryConfig || !fileUrl || typeof fileUrl !== 'string' || !fileUrl.includes('cloudinary.com')) {
        return false;
    }
    try {
        const urlParts = fileUrl.split('/');
        const uploadIndex = urlParts.indexOf('upload');
        if (uploadIndex === -1) return false;
        // public_id is everything after /upload/vXXXXX/ without file extension
        const publicIdWithExt = urlParts.slice(uploadIndex + 2).join('/');
        const publicId = publicIdWithExt.replace(/\.[^.]+$/, '');
        if (!publicId) return false;

        const rawDelete = await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' }).catch(() => null);
        if (rawDelete?.result === 'ok' || rawDelete?.result === 'not found') return true;

        const imageDelete = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' }).catch(() => null);
        if (imageDelete?.result === 'ok' || imageDelete?.result === 'not found') return true;

        const videoDelete = await cloudinary.uploader.destroy(publicId, { resource_type: 'video' }).catch(() => null);
        return videoDelete?.result === 'ok' || videoDelete?.result === 'not found';
    } catch (err) {
        logger.warn('Failed to delete Cloudinary asset (non-fatal):', { error: err.message, fileUrl });
        return false;
    }
}

module.exports = { cloudinary, storage, hasCloudinaryConfig, deleteCloudinaryAsset };
