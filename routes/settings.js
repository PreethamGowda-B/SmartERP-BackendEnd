const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── Ensure columns exist ─────────────────────────────────────────────────────
async function ensureSettingsCols() {
    try {
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB DEFAULT '{}'::jsonb`);
        await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT`);
        await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone TEXT`);
        await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_email TEXT`);
        await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb`);
    } catch (e) {
        console.warn('⚠️  Settings cols ensure error:', e.message);
    }
}
ensureSettingsCols().catch(() => { });

// ─── GET /api/settings/profile ────────────────────────────────────────────────
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const result = await pool.query(
            `SELECT id, name, email, role, phone, notification_prefs FROM users WHERE id = $1`,
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

        // Fetch current hash
        const userResult = await pool.query(
            `SELECT password_hash FROM users WHERE id = $1`,
            [userId]
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
        const prefs = req.body; // e.g. { email: true, push: false, sms: true, ... }

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

// ─── GET /api/settings/company ────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/company', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        const userId = req.user.userId || req.user.id;
        const rawCompanyId = req.user.companyId;
        const isValidUUID = rawCompanyId && UUID_RE.test(rawCompanyId);

        let result;
        if (isValidUUID) {
            // Normal path: companyId from JWT is a real UUID -> look up directly
            result = await pool.query(
                `SELECT c.id, c.name, c.company_id, c.address, c.phone, c.contact_email, c.settings, c.created_at
                 FROM companies c WHERE c.id = $1`,
                [rawCompanyId]
            );
        } else {
            // Fallback: companyId is stale/invalid -> find via the user's record
            result = await pool.query(
                `SELECT c.id, c.name, c.company_id, c.address, c.phone, c.contact_email, c.settings, c.created_at
                 FROM companies c
                 JOIN users u ON u.company_id = c.id
                 WHERE u.id = $1`,
                [userId]
            );
        }

        if (!result.rows.length) return res.status(404).json({ message: 'Company not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('GET /settings/company error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ─── PUT /api/settings/company ────────────────────────────────────────────────
router.put('/company', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        const userId = req.user.userId || req.user.id;
        const rawCompanyId = req.user.companyId;
        const isValidUUID = rawCompanyId && UUID_RE.test(rawCompanyId);
        const { name, address, phone, contact_email, settings } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Company name is required' });
        }

        // Get the real company DB id if companyId is stale
        let companyDbId = isValidUUID ? rawCompanyId : null;
        if (!companyDbId) {
            const lookup = await pool.query(
                `SELECT c.id FROM companies c JOIN users u ON u.company_id = c.id WHERE u.id = $1`,
                [userId]
            );
            if (lookup.rows.length) companyDbId = lookup.rows[0].id;
        }

        if (!companyDbId) return res.status(404).json({ message: 'Company not found' });

        const result = await pool.query(
            `UPDATE companies
       SET name = $1, address = $2, phone = $3, contact_email = $4,
           settings = COALESCE($5::jsonb, settings)
       WHERE id = $6
       RETURNING id, name, company_id, address, phone, contact_email, settings`,
            [
                name.trim(),
                address?.trim() || null,
                phone?.trim() || null,
                contact_email?.trim() || null,
                settings ? JSON.stringify(settings) : null,
                companyDbId
            ]
        );
        res.json({ message: 'Company settings updated', company: result.rows[0] });
    } catch (err) {
        console.error('PUT /settings/company error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
