const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// Ensure upload directory exists
const uploadDir = 'uploads/documents';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Memory storage for now to handle it manually or simple disk storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'doc-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|pdf/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        }
        cb(new Error('Only images (JPG, PNG) and PDFs are allowed'));
    }
});

// ─── POST /api/documents ─────────────────────────────────────────────────────
// Upload a document (Owner/Admin)
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

        // Verify employee belongs to the same company
        const empCheck = await pool.query(
            'SELECT id FROM users WHERE id = $1 AND company_id = $2',
            [employee_id, companyId]
        );

        if (empCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Employee not found in your company' });
        }

        const fileUrl = `/uploads/documents/${req.file.filename}`;

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
// List employees with document counts (Owner/Admin)
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { companyId } = req.user;

        // Optimized query to get all active employees and their document counts
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
        const { companyId } = req.user;
        const { employeeId } = req.params;

        const result = await pool.query(
            `SELECT * FROM employee_documents 
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
// Delete a document
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const { companyId, role } = req.user;
        const { id } = req.params;

        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Permission denied' });
        }

        // Get document to delete file from disk
        const docResult = await pool.query(
            'SELECT file_url FROM employee_documents WHERE id = $1 AND company_id = $2',
            [id, companyId]
        );

        if (docResult.rows.length === 0) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const doc = docResult.rows[0];
        const filePath = path.join(process.cwd(), doc.file_url);

        // Delete from DB first
        await pool.query('DELETE FROM employee_documents WHERE id = $1', [id]);

        // Try to delete from disk
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        res.json({ message: 'Document deleted successfully' });
    } catch (err) {
        console.error('❌ Error deleting document:', err);
        res.status(500).json({ message: 'Server error deleting document' });
    }
});

module.exports = router;
