/**
 * 🛡️ Server-Side File Signature (Magic Byte) Validation Utility
 *
 * ⚠️ SECURITY NOTE:
 * Magic-byte validation verifies that a file starts with the expected binary signature
 * for its claimed type (preventing executable or script files renamed to .png/.jpg/.pdf).
 * However, magic-byte checking ALONE does not guarantee an uploaded file is harmless.
 * Full defense-in-depth requires pairing magic-byte validation with:
 * 1. Strict file size limits.
 * 2. MIME allowlists and extension consistency.
 * 3. Processing and re-encoding through Cloudinary CDN transformations (which strips metadata and neutralizes polyglot payloads).
 * 4. Serving assets from isolated, sandboxed domains (`res.cloudinary.com`) with restrictive Content-Disposition headers.
 */

const MIME_SIGNATURES = {
  PNG: {
    mime: 'image/png',
    extensions: ['png'],
    check: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
  },
  JPEG: {
    mime: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
    check: (buf) =>
      buf.length >= 3 &&
      buf[0] === 0xff &&
      buf[1] === 0xd8 &&
      buf[2] === 0xff
  },
  PDF: {
    mime: 'application/pdf',
    extensions: ['pdf'],
    check: (buf) =>
      buf.length >= 4 &&
      buf[0] === 0x25 && // %
      buf[1] === 0x50 && // P
      buf[2] === 0x44 && // D
      buf[3] === 0x46    // F
  },
  WEBP: {
    mime: 'image/webp',
    extensions: ['webp'],
    check: (buf) =>
      buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50  // WEBP
  },
  GIF: {
    mime: 'image/gif',
    extensions: ['gif'],
    check: (buf) =>
      buf.length >= 6 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 && // GIF8
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61                      // 7a or 9a
  }
};

/**
 * Safely inspects a buffer and identifies its genuine MIME type and extension.
 * Gracefully handles truncated, zero-byte, or corrupted buffers without throwing.
 *
 * @param {Buffer} buffer - Raw file buffer
 * @returns {{ mime: string, extension: string, type: string } | null}
 */
function detectFileSignature(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  try {
    for (const [typeKey, sig] of Object.entries(MIME_SIGNATURES)) {
      if (sig.check(buffer)) {
        return {
          type: typeKey,
          mime: sig.mime,
          extension: sig.extensions[0]
        };
      }
    }
  } catch (_) {
    // Fail closed on any inspection anomalies
    return null;
  }

  return null;
}

/**
 * Express middleware generator that verifies file signature against an allowed list of MIME types.
 * Must be placed AFTER `multer.single()` or `multer.array()`.
 *
 * @param {Object} options
 * @param {string[]} options.allowedMimes - Array of allowed MIME strings (e.g. ['image/png', 'image/jpeg', 'application/pdf'])
 * @param {string} [options.fieldName='file'] - The field name in req.file or req.files
 * @param {boolean} [options.required=true] - Whether a file is mandatory for this route
 */
function requireValidFileSignature({ allowedMimes, fieldName = 'file', required = true }) {
  const allowedSet = new Set(allowedMimes.map((m) => m.toLowerCase().trim()));

  return (req, res, next) => {
    const file = req.file || (req.files && req.files[fieldName]) || (req.files && req.files[0]);

    if (!file) {
      if (required) {
        return res.status(400).json({ message: 'No file provided for upload' });
      }
      return next();
    }

    if (!file.buffer || !Buffer.isBuffer(file.buffer)) {
      return res.status(400).json({ message: 'File payload is invalid or could not be read' });
    }

    if (file.buffer.length === 0) {
      return res.status(400).json({ message: 'Uploaded file is empty (0 bytes)' });
    }

    const detected = detectFileSignature(file.buffer);

    if (!detected || !allowedSet.has(detected.mime)) {
      return res.status(400).json({
        message: 'Invalid file content: The file binary signature does not match any allowed file type.',
        detectedType: detected ? detected.mime : 'unknown/unsupported',
        allowedTypes: Array.from(allowedSet)
      });
    }

    // Attach validated metadata to file object for downstream consumers
    file.validatedMime = detected.mime;
    file.validatedExtension = detected.extension;

    next();
  };
}

module.exports = {
  detectFileSignature,
  requireValidFileSignature,
  MIME_SIGNATURES
};
