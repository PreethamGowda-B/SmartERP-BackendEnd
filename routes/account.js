const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const AccountDeletionService = require('../services/accountDeletionService');
const { pool } = require('../db');
const bcrypt = require('bcrypt');
const { storage } = require('../middleware/als');

// Enable safe ALS bypass for personal user management
router.use((req, res, next) => storage.run({ isWebRequest: true, bypassRls: true }, next));

// ─── POST /api/account/deletion/request ─────────────────────────────────────
// Step 1: Initiate Deletion Challenge with re-authentication & blocker checks
router.post('/deletion/request', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId || req.user.company_id;
    const role = req.user.role;
    const { password, is_oauth } = req.body;

    const result = await AccountDeletionService.requestStaffDeletion({
      userId,
      companyId,
      role,
      password,
      isOAuth: is_oauth || false,
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent']
    });

    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        success: false,
        message: err.message,
        requiresOwnershipTransfer: err.requiresOwnershipTransfer || false
      });
    }
    console.error('❌ Error requesting account deletion:', err.message);
    res.status(500).json({ success: false, message: 'Server error requesting account deletion' });
  }
});

// ─── POST /api/account/deletion/confirm ─────────────────────────────────────
// Step 2: Confirm Deletion Challenge with Exact Phrase & One-Time Token
router.post('/deletion/confirm', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId || req.user.company_id;
    const { challenge_token, confirmation_phrase, reason } = req.body;

    const result = await AccountDeletionService.confirmStaffDeletion({
      userId,
      companyId,
      challengeToken: challenge_token,
      confirmationPhrase: confirmation_phrase,
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
      reason
    });

    // Clear authentication cookies
    res.clearCookie('user_access_token', { path: '/' });
    res.clearCookie('user_refresh_token', { path: '/' });
    res.clearCookie('superadmin_access_token', { path: '/' });
    res.clearCookie('superadmin_refresh_token', { path: '/' });

    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error('❌ Error confirming account deletion:', err.message);
    res.status(500).json({ success: false, message: 'Server error executing account deletion' });
  }
});

// ─── POST /api/account/transfer-ownership ───────────────────────────────────
// Safe Owner Transfer before Deletion
router.post('/transfer-ownership', authenticateToken, async (req, res) => {
  return storage.run({ isWebRequest: true, bypassRls: true }, async () => {
    const client = await pool.connect();
    try {
      const currentUserId = req.user.userId || req.user.id;
      const companyId = req.user.companyId || req.user.company_id;
      const userRole = req.user.role;
      const { new_owner_id, password } = req.body;

      if (userRole !== 'owner') {
        return res.status(403).json({ message: 'Access denied: Only company owners can transfer ownership.' });
      }

      if (!new_owner_id || !password) {
        return res.status(400).json({ message: 'new_owner_id and password confirmation are required.' });
      }

      if (String(new_owner_id) === String(currentUserId)) {
        return res.status(400).json({ message: 'Cannot transfer ownership to yourself.' });
      }

      // Verify current owner password
      const ownerRes = await client.query('SELECT password_hash FROM users WHERE id::text = $1::text', [currentUserId]);
      if (!ownerRes.rows.length || !ownerRes.rows[0].password_hash) {
        return res.status(401).json({ message: 'Invalid owner account.' });
      }
      const match = await bcrypt.compare(password, ownerRes.rows[0].password_hash);
      if (!match) {
        return res.status(401).json({ message: 'Incorrect password confirmation.' });
      }

      // Verify target user is in same company and active
      const targetRes = await client.query(
        `SELECT id, name, email, role FROM users
         WHERE id::text = $1::text AND company_id::text = $2::text AND (is_deleted IS NULL OR is_deleted = FALSE)`,
        [new_owner_id, String(companyId)]
      );

      if (!targetRes.rows.length) {
        return res.status(404).json({ message: 'Designated user not found in your company organization.' });
      }

      await client.query('BEGIN');

      // Elevate new user to owner
      await client.query(
        `UPDATE users SET role = 'owner' WHERE id::text = $1::text`,
        [new_owner_id]
      );

      // Demote current user to employee so they can proceed to personal account deletion
      await client.query(
        `UPDATE users SET role = 'employee' WHERE id::text = $1::text`,
        [currentUserId]
      );

      // Update company owner_id
      await client.query(
        `UPDATE companies SET owner_id = $1 WHERE id::text = $2::text OR company_id = $3`,
        [new_owner_id, String(companyId), String(companyId)]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Ownership successfully transferred. Your role is now employee, and you may now proceed with account deletion.'
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('❌ Error transferring ownership:', err.message);
      res.status(500).json({ message: 'Server error during ownership transfer.' });
    } finally {
      client.release();
    }
  });
});

module.exports = router;
