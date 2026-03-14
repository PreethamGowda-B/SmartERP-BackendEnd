const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── Ensure optional columns exist ────────────────────────────────────────────
// companies table has: id, company_id (short code VARCHAR), company_name, owner_id, created_at
// We add optional extra cols: address, phone, contact_email, settings


// ─── Helper: get company row for a user ───────────────────────────────────────
// JWT stores companyId as the integer companies.id
async function getCompanyForUser(req) {
    const userId = req.user.userId || req.user.id;
    const jwtCompanyId = req.user.companyId; // integer companies.id from JWT

    const safeSelect = `
        SELECT c.id,
               c.company_name                          AS name,
               COALESCE(c.company_id, '')              AS company_id,
               COALESCE(c.address, '')                 AS address,
               COALESCE(c.phone, '')                   AS phone,
               COALESCE(c.contact_email, '')           AS contact_email,
               c.created_at
        FROM companies c`;

    let result;
    if (jwtCompanyId) {
        // Primary path: use the integer id stored in JWT
        result = await pool.query(`${safeSelect} WHERE c.id = $1`, [jwtCompanyId]);
    }
    if (!result || !result.rows.length) {
        // Fallback: look up via users.company_id FK
        result = await pool.query(
            `${safeSelect} JOIN users u ON u.company_id = c.id WHERE u.id = $1`,
            [userId]
        );
    }
    return result.rows[0] || null;
}

// ─── GET /api/settings/profile ────────────────────────────────────────────────
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const result = await pool.query(
            `SELECT id, name, email, role,
                    COALESCE(phone, '') AS phone,
                    COALESCE(notification_prefs, '{}'::jsonb) AS notification_prefs
             FROM users WHERE id = $1`,
            [userId]
        );
        if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('GET /settings/profile error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ─── PUT /api/settings/profile ────────────────────────────────────────────────
router.put('/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const { name, phone } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Name is required' });
        }

        const result = await pool.query(
            `UPDATE users SET name = $1, phone = $2 WHERE id = $3
             RETURNING id, name, email, phone, role`,
            [name.trim(), phone?.trim() || null, userId]
        );
        res.json({ message: 'Profile updated successfully', user: result.rows[0] });
    } catch (err) {
        console.error('PUT /settings/profile error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ─── PUT /api/settings/change-password ───────────────────────────────────────
router.put('/change-password', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Both current and new password are required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'New password must be at least 6 characters' });
        }

        const userResult = await pool.query(
            `SELECT password_hash FROM users WHERE id = $1`, [userId]
        );
        if (!userResult.rows.length) return res.status(404).json({ message: 'User not found' });

        const match = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
        if (!match) {
            return res.status(400).json({ message: 'Current password is incorrect' });
        }

        const newHash = await bcrypt.hash(newPassword, 10);
        await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, userId]);

        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        console.error('PUT /settings/change-password error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ─── PUT /api/settings/notification-prefs ────────────────────────────────────
router.put('/notification-prefs', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const prefs = req.body;

        await pool.query(
            `UPDATE users SET notification_prefs = $1 WHERE id = $2`,
            [JSON.stringify(prefs), userId]
        );
        res.json({ message: 'Preferences saved' });
    } catch (err) {
        console.error('PUT /settings/notification-prefs error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ─── GET /api/settings/company (owner/admin only) ─────────────────────────────
router.get('/company', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        const company = await getCompanyForUser(req);
        if (!company) return res.status(404).json({ message: 'Company not found' });
        res.json(company);
    } catch (err) {
        console.error('GET /settings/company error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ─── GET /api/settings/company-info (all authenticated users) ─────────────────
// Employees can read their company's info (read-only)
router.get('/company-info', authenticateToken, async (req, res) => {
    try {
        const company = await getCompanyForUser(req);
        if (!company) return res.status(404).json({ message: 'Company not found' });
        res.json(company);
    } catch (err) {
        console.error('GET /settings/company-info error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ─── PUT /api/settings/company (owner/admin only) ─────────────────────────────
router.put('/company', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const userId = req.user.userId || req.user.id;
        const jwtCompanyId = req.user.companyId;
        const { name, address, phone, contact_email, settings, company_id } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Company name is required' });
        }

        // Resolve the integer companies.id
        let companyDbId = jwtCompanyId || null;
        if (!companyDbId) {
            const lookup = await pool.query(
                `SELECT c.id FROM companies c JOIN users u ON u.company_id = c.id WHERE u.id = $1`,
                [userId]
            );
            if (lookup.rows.length) companyDbId = lookup.rows[0].id;
        }
        if (!companyDbId) return res.status(404).json({ message: 'Company not found' });

        // Update company — company_name is the real column; company_id is the short code
        const result = await pool.query(
            `UPDATE companies
             SET company_name   = $1,
                 address        = $2,
                 phone          = $3,
                 contact_email  = $4,
                 company_id     = CASE WHEN $5::text <> '' THEN $5 ELSE company_id END,
                 settings       = COALESCE($6::jsonb, settings),
                 updated_at     = NOW()
             WHERE id = $7
             RETURNING id,
                       company_name         AS name,
                       company_id,
                       COALESCE(address,'') AS address,
                       COALESCE(phone,'')   AS phone,
                       COALESCE(contact_email,'') AS contact_email`,
            [
                name.trim(),
                address?.trim() || null,
                phone?.trim() || null,
                contact_email?.trim() || null,
                company_id?.trim() || '',
                settings ? JSON.stringify(settings) : null,
                companyDbId,
            ]
        );
        res.json({ message: 'Company settings updated', company: result.rows[0] });
    } catch (err) {
        console.error('PUT /settings/company error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
