const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const AccountDeletionService = require('../services/accountDeletionService');
const { pool } = require('../db');
const bcrypt = require('bcrypt');
const { storage } = require('../middleware/als');

// ─── POST /api/account/deletion/request ─────────────────────────────────────
// Step 1: Initiate Deletion Challenge with re-authentication & blocker checks
router.post('/deletion/request', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId || req.user.company_id;
    const role = req.user.role;
    const { password, otp, is_oauth } = req.body;

    const result = await AccountDeletionService.requestStaffDeletion({
      userId,
      companyId,
      role,
      password,
      otp,
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
  if (String(req.user.role || '').toLowerCase() !== 'owner') {
    return res.status(403).json({ message: 'Access denied: Only company owners can transfer ownership.' });
  }
  try {
    await require('../services/accountOwnershipTransfer').transferOwnership({
      pool,
      storage,
      bcrypt,
      currentUserId: req.user.userId || req.user.id,
      companyId: req.user.companyId || req.user.company_id,
      newOwnerId: req.body?.new_owner_id,
      password: req.body?.password,
    });
    return res.json({
      success: true,
      message: 'Ownership successfully transferred. Your role is now employee, and you may now proceed with account deletion.'
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    console.error('❌ Error transferring ownership:', err?.code || err?.name || 'TRANSFER_FAILED');
    return res.status(500).json({ message: 'Server error during ownership transfer.' });
  }
});
module.exports = router;
