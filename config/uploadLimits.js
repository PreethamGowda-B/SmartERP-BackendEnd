/**
 * Centralized upload size configuration for SmartERP backend.
 *
 * Policy: Every individual file upload must be 5 MB or smaller.
 * This constant is shared across all upload routes so that the limit
 * is enforced consistently from a single source of truth.
 *
 * 5 MiB = 5 * 1024 * 1024 = 5,242,880 bytes
 */

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB in bytes

/**
 * Returns a consistent Multer error-handling middleware.
 * Place AFTER multer().single() / multer().array() in a route's middleware stack.
 *
 * Usage:
 *   router.post('/upload', upload.single('file'), handleMulterError, requireValidFileSignature(...), handler)
 */
function handleMulterError(err, req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      message: 'File is too large. Maximum allowed size is 5 MB.',
      code: 'FILE_TOO_LARGE',
      maxSizeBytes: MAX_FILE_SIZE,
    });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      message: 'Too many files. Only one file may be uploaded at a time.',
      code: 'TOO_MANY_FILES',
    });
  }
  if (err) {
    return res.status(400).json({
      message: err.message || 'File upload rejected.',
      code: 'UPLOAD_ERROR',
    });
  }
  next();
}

module.exports = { MAX_FILE_SIZE, handleMulterError };
