const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { cloudinary, hasCloudinaryConfig, deleteCloudinaryAsset } = require('../config/cloudinary');
const { requireValidFileSignature } = require('../utils/fileValidation');
const { loadPlan, checkPlanLimit } = require('../middleware/planMiddleware');
const { recordCompanyStorageUsage, removeCompanyStorageUsage } = require('../services/companyStorage');
const { measureDatabaseFileParameter, withOutboundOperation } = require('../utils/outboundBandwidth');
const { MAX_FILE_SIZE, handleMulterError } = require('../config/uploadLimits');

// Use in-memory storage — we upload directly to Cloudinary, no local disk needed
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE }, // 5 MB – global SmartERP upload policy
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
        const ext = (file.originalname || '').toLowerCase();
        const hasAllowedExt = ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.png') || ext.endsWith('.pdf');
        if (allowed.includes(file.mimetype) || hasAllowedExt) {
            return cb(null, true);
        }
        cb(new Error('Only images (JPG, PNG) and PDFs are allowed'));
    }
});

// ─── POST /api/documents ─────────────────────────────────────────────────────
// Upload a document to Cloudinary (Owner/Admin only)
router.post(
    '/',
    authenticateToken,
    loadPlan,
    upload.single('file'),
    handleMulterError,
    requireValidFileSignature({
        allowedMimes: ['image/jpeg', 'image/png', 'application/pdf'],
        fieldName: 'file',
        required: true
    }),
    checkPlanLimit('storage', { getRequestedUsage: (req) => req.file?.size || 0 }),
    async (req, res) => {
    try {
        const { role, companyId, userId } = req.user;
        const { employee_id, document_type, notes } = req.body;

        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Only owners and admins can upload documents' });
        }

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        if (!employee_id || !document_type) {
            return res.status(400).json({ message: 'Missing employee_id or document_type' });
        }

        if (!hasCloudinaryConfig) {
            return res.status(503).json({ message: 'File storage is not configured. Contact support.' });
        }

        // Verify employee belongs to same company
        const empCheck = await pool.query(
            'SELECT id FROM users WHERE id = $1 AND company_id = $2',
            [employee_id, companyId]
        );
        if (empCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Employee not found in your company' });
        }

        const storageKey = `employee-document:${crypto.randomUUID()}`;
        await recordCompanyStorageUsage(companyId, storageKey, req.file.size, 'employee_document');

        // Upload buffer to Cloudinary or fallback to local disk
        const isImage = req.file.mimetype.startsWith('image/');
        let fileUrl = null;

        if (hasCloudinaryConfig) {
            try {
                    const uploadResult = await withOutboundOperation('cloudinary', 'employee_document_upload', () => new Promise((resolve, reject) => {
                        const stream = cloudinary.uploader.upload_stream(
                            {
                                folder: `smarterp/documents/${companyId}`,
                                resource_type: isImage ? 'image' : 'raw',
                                public_id: `doc_${crypto.randomUUID()}`,
                                ...(isImage && { transformation: [{ width: 1600, crop: 'limit' }] })
                            },
                            (error, result) => {
                                if (error) reject(error);
                                else resolve(result);
                            }
                        );
                        stream.end(req.file.buffer);
                    }), { responsibleModule: 'routes/documents' });
                fileUrl = uploadResult.secure_url;
            } catch (cloudErr) {
                console.warn('⚠️ Cloudinary upload failed, falling back to local storage:', cloudErr.message);
            }
        }

        // If Cloudinary failed or is unavailable, seamlessly fallback to database binary storage
        if (!fileUrl) {
            try {
                console.log('📦 Persisting document to database media storage fallback...');
                const mediaRes = await measureDatabaseFileParameter({
                    operation: 'employee_document_fallback_insert',
                    fileBytes: req.file.buffer.byteLength,
                    run: () => pool.query(
                        `INSERT INTO message_media_files (file_name, file_type, file_size, data, company_id, uploaded_by)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         RETURNING id`,
                        [req.file.originalname || `doc_${crypto.randomUUID()}`, req.file.mimetype, req.file.size, req.file.buffer, String(companyId), String(userId)]
                    ),
                });
                const baseUrl = process.env.BASE_URL || process.env.BACKEND_URL || 'https://api.prozync.in';
                fileUrl = `${baseUrl}/api/messages/media/${mediaRes.rows[0].id}`;
                console.log('✅ Document saved to database media fallback:', fileUrl);
            } catch (dbErr) {
                console.error('❌ Database fallback document upload failed:', dbErr.message);
            }
        }

        // Reject only if both cloud and database fallback failed
        if (!fileUrl) {
            await removeCompanyStorageUsage(companyId, storageKey);
            return res.status(502).json({ 
                message: 'Failed to upload document to secure cloud storage. Please verify file format and try again.' 
            });
        }

        const result = await pool.query(
            `INSERT INTO employee_documents 
             (company_id, employee_id, document_type, file_url, notes, uploaded_by, file_size_bytes, storage_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [companyId, employee_id, document_type, fileUrl, notes || null, userId, req.file.size, storageKey]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('❌ Error uploading document:', err);
        res.status(500).json({ message: 'Server error uploading document' });
    }
});

// ─── GET /api/documents ──────────────────────────────────────────────────────
// List employees with document counts (Owner/Admin only)
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { role, companyId } = req.user;

        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Only owners and admins can view document lists' });
        }

        const result = await pool.query(
            `SELECT u.id, u.name, u.email, u.position, u.department,
             COUNT(d.id) as document_count
             FROM users u
             LEFT JOIN employee_documents d ON u.id = d.employee_id
             WHERE u.company_id = $1 AND u.role = 'employee'
             GROUP BY u.id
             ORDER BY u.name ASC`,
            [companyId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('❌ Error fetching employees for documents:', err);
        res.status(500).json({ message: 'Server error fetching document list' });
    }
});

// ─── GET /api/documents/employee/:employeeId ─────────────────────────────────
// List all documents for a specific employee
router.get('/employee/:employeeId', authenticateToken, async (req, res) => {
    try {
        const { role, companyId } = req.user;
        const { employeeId } = req.params;

        // Employees can view their own docs; owners/admins can view any employee in their company
        if (role !== 'owner' && role !== 'admin') {
            const userId = req.user.userId || req.user.id;
            if (String(employeeId) !== String(userId)) {
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        const result = await pool.query(
            `SELECT id, document_type, file_url, notes, created_at
             FROM employee_documents 
             WHERE employee_id::text = $1::text AND company_id = $2
             ORDER BY created_at DESC`,
            [employeeId, companyId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('❌ Error fetching employee documents:', err);
        res.status(500).json({ message: 'Server error fetching employee documents' });
    }
});

// ─── GET /api/documents/:id/download ─────────────────────────────────────────
// Authorized document download/view with company isolation & role verification
router.get('/:id/download', authenticateToken, async (req, res) => {
    try {
        const { role, companyId } = req.user;
        const userId = req.user.userId || req.user.id;
        const { id } = req.params;

        const docResult = await pool.query(
            `SELECT d.id, d.company_id, d.employee_id, d.document_type, d.file_url, d.storage_key
             FROM employee_documents d
             WHERE d.id = $1 AND d.company_id = $2`,
            [id, companyId]
        );

        if (docResult.rows.length === 0) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const doc = docResult.rows[0];

        // Authorization check: owner, admin, or the employee themselves
        if (role !== 'owner' && role !== 'admin') {
            if (String(doc.employee_id) !== String(userId)) {
                return res.status(403).json({ message: 'Access denied to this document' });
            }
        }

        if (!doc.file_url) {
            return res.status(404).json({ message: 'Document file URL missing' });
        }

        return res.redirect(doc.file_url);
    } catch (err) {
        console.error('❌ Error downloading document:', err);
        res.status(500).json({ message: 'Server error downloading document' });
    }
});

// ─── DELETE /api/documents/:id ───────────────────────────────────────────────
// Delete a document (removes from Cloudinary + DB)
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const { companyId, role } = req.user;
        const { id } = req.params;

        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Permission denied' });
        }

        const docResult = await pool.query(
            'SELECT file_url, storage_key, id FROM employee_documents WHERE id = $1 AND company_id = $2',
            [id, companyId]
        );

        if (docResult.rows.length === 0) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const { file_url, storage_key: storageKey } = docResult.rows[0];

        // Delete from DB first with explicit company_id guard
        await pool.query('DELETE FROM employee_documents WHERE id = $1 AND company_id = $2', [id, companyId]);

        // Clean up underlying storage: Cloudinary or database media files
        if (file_url && file_url.includes('/api/messages/media/')) {
            const mediaId = file_url.match(/\/api\/messages\/media\/([0-9a-f-]{36})/i)?.[1];
            if (mediaId) {
                await pool.query('DELETE FROM message_media_files WHERE id = $1', [mediaId]).catch(() => {});
            }
        } else if (file_url && file_url.includes('cloudinary.com')) {
            await deleteCloudinaryAsset(file_url).catch(() => {});
        }

        // Always release company storage usage tracking
        await removeCompanyStorageUsage(companyId, storageKey || `employee-document:${id}`).catch(() => {});

        res.json({ message: 'Document deleted successfully' });
    } catch (err) {
        console.error('❌ Error deleting document:', err);
        res.status(500).json({ message: 'Server error deleting document' });
    }
});

module.exports = router;
