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
               COALESCE(c.settings, '{}'::jsonb)       AS settings,
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

    if (!result.rows.length) return null;
    const row = result.rows[0];
    const s = row.settings || {};

    return {
        id: row.id,
        name: row.name,
        legal_name: s.legal_name || row.name,
        company_id: row.company_id,
        address: row.address || s.address || '',
        city: s.city || '',
        state: s.state || '',
        country: s.country || 'India',
        pincode: s.pincode || '',
        phone: row.phone || s.phone || '',
        contact_email: row.contact_email || s.contact_email || '',
        website: s.website || '',
        gstin: s.gstin || '',
        pan: s.pan || '',
        cin: s.cin || '',
        registration_number: s.registration_number || '',
        bank_name: s.bank_name || '',
        account_number: s.account_number || '',
        ifsc_code: s.ifsc_code || '',
        upi_id: s.upi_id || '',
        authorized_signatory_name: s.authorized_signatory_name || '',
        logo_url: s.logo_url || '',
        stamp_url: s.stamp_url || '',
        terms_and_conditions: s.terms_and_conditions || '1. Payment is due within 15 days of invoice date.\n2. Interest @ 18% p.a. will be charged on overdue invoices.',
        default_notes: s.default_notes || 'Thank you for choosing our services!',
        settings: s
    };
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
        res.status(500).json({ message: "An internal server error occurred. Please try again." });
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
        res.status(500).json({ message: "An internal server error occurred. Please try again." });
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
        res.status(500).json({ message: "An internal server error occurred. Please try again." });
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
        res.status(500).json({ message: "An internal server error occurred. Please try again." });
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
        res.status(500).json({ message: "An internal server error occurred. Please try again." });
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
        res.status(500).json({ message: "An internal server error occurred. Please try again." });
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

        // Merge all branding, tax, and bank fields into settings JSONB
        const existingRes = await pool.query(`SELECT settings FROM companies WHERE id = $1`, [companyDbId]);
        const existingSettings = existingRes.rows[0]?.settings || {};

        const mergedSettings = {
            ...existingSettings,
            ...(settings || {}),
            legal_name: req.body.legal_name ?? settings?.legal_name ?? existingSettings.legal_name ?? name.trim(),
            logo_url: req.body.logo_url ?? settings?.logo_url ?? existingSettings.logo_url ?? '',
            gstin: req.body.gstin ?? settings?.gstin ?? existingSettings.gstin ?? '',
            pan: req.body.pan ?? settings?.pan ?? existingSettings.pan ?? '',
            cin: req.body.cin ?? settings?.cin ?? existingSettings.cin ?? '',
            registration_number: req.body.registration_number ?? settings?.registration_number ?? existingSettings.registration_number ?? '',
            city: req.body.city ?? settings?.city ?? existingSettings.city ?? '',
            state: req.body.state ?? settings?.state ?? existingSettings.state ?? '',
            country: req.body.country ?? settings?.country ?? existingSettings.country ?? 'India',
            pincode: req.body.pincode ?? settings?.pincode ?? existingSettings.pincode ?? '',
            website: req.body.website ?? settings?.website ?? existingSettings.website ?? '',
            bank_name: req.body.bank_name ?? settings?.bank_name ?? existingSettings.bank_name ?? '',
            account_number: req.body.account_number ?? settings?.account_number ?? existingSettings.account_number ?? '',
            ifsc_code: req.body.ifsc_code ?? settings?.ifsc_code ?? existingSettings.ifsc_code ?? '',
            upi_id: req.body.upi_id ?? settings?.upi_id ?? existingSettings.upi_id ?? '',
            authorized_signatory_name: req.body.authorized_signatory_name ?? settings?.authorized_signatory_name ?? existingSettings.authorized_signatory_name ?? '',
            stamp_url: req.body.stamp_url ?? settings?.stamp_url ?? existingSettings.stamp_url ?? '',
            terms_and_conditions: req.body.terms_and_conditions ?? settings?.terms_and_conditions ?? existingSettings.terms_and_conditions ?? '',
            default_notes: req.body.default_notes ?? settings?.default_notes ?? existingSettings.default_notes ?? ''
        };

        const result = await pool.query(
            `UPDATE companies
             SET company_name   = $1,
                 address        = $2,
                 phone          = $3,
                 contact_email  = $4,
                 settings       = $5::jsonb,
                 updated_at     = NOW()
             WHERE id = $6
             RETURNING *`,
            [
                name.trim(),
                address?.trim() || null,
                phone?.trim() || null,
                contact_email?.trim() || null,
                JSON.stringify(mergedSettings),
                companyDbId,
            ]
        );

        const updatedCompany = await getCompanyForUser(req);
        res.json({ message: 'Company settings updated', company: updatedCompany });
    } catch (err) {
        console.error('PUT /settings/company error:', err.message);
        res.status(500).json({ message: "An internal server error occurred. Please try again." });
    }
});

module.exports = router;
