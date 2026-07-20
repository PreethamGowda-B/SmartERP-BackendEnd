const express = require('express');
const router = express.Router();
const multer = require('multer');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { cloudinary, hasCloudinaryConfig } = require('../config/cloudinary');

// Use in-memory storage — we upload directly to Cloudinary, no local disk needed
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/pdf', 'application/pdf'];
        // Also allow by extension for edge cases
        const ext = file.originalname.toLowerCase();
        if (allowed.includes(file.mimetype) || ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.png') || ext.endsWith('.pdf')) {
            return cb(null, true);
        }
        cb(new Error('Only images (JPG, PNG) and PDFs are allowed'));
    }
});

// ─── POST /api/documents ─────────────────────────────────────────────────────
// Upload a document to Cloudinary (Owner/Admin only)
router.post('/', authenticateToken, upload.single('file'), async (req, res) => {
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

        // Upload buffer to Cloudinary under smarterp/documents
        const isImage = req.file.mimetype.startsWith('image/');
        const uploadResult = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder: `smarterp/documents/${companyId}`,
                    resource_type: isImage ? 'image' : 'raw',
                    public_id: `doc_${Date.now()}`,
                    ...(isImage && { transformation: [{ width: 1600, crop: 'limit' }] })
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            stream.end(req.file.buffer);
        });

        const fileUrl = uploadResult.secure_url;

        const result = await pool.query(
            `INSERT INTO employee_documents 
             (company_id, employee_id, document_type, file_url, notes, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [companyId, employee_id, document_type, fileUrl, notes || null, userId]
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
             WHERE employee_id = $1 AND company_id = $2
             ORDER BY created_at DESC`,
            [employeeId, companyId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('❌ Error fetching employee documents:', err);
        res.status(500).json({ message: 'Server error fetching employee documents' });
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
            'SELECT file_url FROM employee_documents WHERE id = $1 AND company_id = $2',
            [id, companyId]
        );

        if (docResult.rows.length === 0) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const { file_url } = docResult.rows[0];

        // Delete from DB first (always succeeds)
        await pool.query('DELETE FROM employee_documents WHERE id = $1', [id]);

        // Attempt to delete from Cloudinary (non-critical — file might already be gone)
        if (hasCloudinaryConfig && file_url && file_url.includes('cloudinary.com')) {
            try {
                // Extract public_id from Cloudinary URL
                const urlParts = file_url.split('/');
                const uploadIndex = urlParts.indexOf('upload');
                if (uploadIndex !== -1) {
                    // public_id is everything after /upload/vXXXXX/ without extension
                    const publicIdWithExt = urlParts.slice(uploadIndex + 2).join('/');
                    const publicId = publicIdWithExt.replace(/\.[^.]+$/, '');
                    await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' }).catch(() =>
                        cloudinary.uploader.destroy(publicId, { resource_type: 'image' }).catch(() => {})
                    );
                }
            } catch (cloudErr) {
                console.warn('⚠️ Could not delete from Cloudinary (non-fatal):', cloudErr.message);
            }
        }

        res.json({ message: 'Document deleted successfully' });
    } catch (err) {
        console.error('❌ Error deleting document:', err);
        res.status(500).json({ message: 'Server error deleting document' });
    }
});

module.exports = router;
