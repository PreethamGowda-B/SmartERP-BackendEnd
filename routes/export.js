/**
 * routes/export.js
 * Secure, owner-only endpoints for full tenant data backups and exports.
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const DataExportService = require('../services/dataExportService');
const { pool } = require('../db');

// Require Owner role
const requireOwner = (req, res, next) => {
  if (req.user?.role !== 'owner' && req.user?.role !== 'super_admin') {
    return res.status(403).json({
      message: 'Access denied: Only company owners can download full enterprise data backups.'
    });
  }
  next();
};

/**
 * GET /api/export/company-backup
 * Streams a compressed .ZIP file with all company CSVs and metadata.
 */
router.get('/company-backup', authenticateToken, requireOwner, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) {
      return res.status(400).json({ message: 'No company associated with this account.' });
    }

    const companyRes = await pool.query('SELECT company_id, company_name FROM companies WHERE id = $1', [companyId]);
    const companyCode = companyRes.rows[0]?.company_id || 'COMPANY';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `SmartERP_Backup_${companyCode}_${timestamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await DataExportService.streamCompanyBackup({ companyId, res });
  } catch (err) {
    console.error('❌ Error generating company backup zip:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Failed to generate company data backup.' });
    }
  }
});

module.exports = router;
