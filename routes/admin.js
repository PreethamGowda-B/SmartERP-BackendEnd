const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { authenticateSuperAdmin } = require('../middleware/adminMiddleware');

// All routes in this file require both a valid token AND super_admin privileges
router.use(authenticateToken);
router.use(authenticateSuperAdmin);

// ─── GET /api/admin/dashboard ────────────────────────────────────────────────
// Aggregate platform-wide statistics
router.get('/dashboard', async (req, res) => {
  try {
    // 1. Total Companies
    const companyCount = await pool.query('SELECT COUNT(*) FROM companies');
    
    // 2. Total Users
    const userCount = await pool.query('SELECT COUNT(*) FROM users');
    
    // 3. Active Subscriptions (Non-free plans that aren't expired)
    const activeSubs = await pool.query(`
      SELECT COUNT(*) FROM companies 
      WHERE plan_id > 1 
      AND (subscription_expires_at > NOW() OR subscription_expires_at IS NULL)
    `);
    
    // 4. Trial Users
    const trialUsers = await pool.query('SELECT COUNT(*) FROM companies WHERE is_on_trial = TRUE');
    
    // 5. Recent Activity (Last 24h)
    const recentActivity = await pool.query('SELECT COUNT(*) FROM activities WHERE created_at > NOW() - INTERVAL \'24 hours\'');

    res.json({
      stats: {
        totalCompanies: parseInt(companyCount.rows[0].count),
        totalUsers: parseInt(userCount.rows[0].count),
        activeSubscriptions: parseInt(activeSubs.rows[0].count),
        trialUsers: parseInt(trialUsers.rows[0].count),
        recentActivity24h: parseInt(recentActivity.rows[0].count)
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Superadmin Dashboard Error:', err);
    res.status(500).json({ message: 'Server error fetching platform statistics' });
  }
});

// ─── GET /api/admin/companies ──────────────────────────────────────────────
// List all companies with owner info and subscription status
router.get('/companies', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.*, 
        u.name as owner_name, 
        u.email as owner_email,
        p.name as plan_name
      FROM companies c
      LEFT JOIN users u ON c.owner_id = u.id
      LEFT JOIN plans p ON c.plan_id = p.id
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching companies:', err);
    res.status(500).json({ message: 'Server error fetching companies' });
  }
});

// ─── PATCH /api/admin/companies/:id/status ──────────────────────────────────
// Suspend or activate a company (Requires status column)
router.patch('/companies/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'active', 'suspended'

  try {
    const result = await pool.query(
      'UPDATE companies SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Company not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.message.includes('column "status" does not exist')) {
        // Safe fallback if column isn't migrated yet
        return res.status(400).json({ message: 'Status management not yet supported in schema' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/users ───────────────────────────────────────────────────
// Platform-wide user list
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.*, c.company_name 
      FROM users u
      LEFT JOIN companies c ON u.company_id = c.id
      ORDER BY u.created_at DESC
      LIMIT 1000
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching platform users:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PATCH /api/admin/subscriptions/:companyId ──────────────────────────────
// Manually override a company's plan
router.patch('/subscriptions/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const { plan_id, expires_at } = req.body;

  try {
    const result = await pool.query(
      'UPDATE companies SET plan_id = $1, subscription_expires_at = $2, is_on_trial = FALSE WHERE id = $3 RETURNING *',
      [plan_id, expires_at, companyId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /api/admin/announcements ──────────────────────────────────────────
// Broadcast message to all company owners
router.post('/announcements', async (req, res) => {
    const { title, message, priority } = req.body;

    try {
        // Fetch all company owners
        const owners = await pool.query("SELECT id, company_id FROM users WHERE role = 'owner'");
        
        const notifications = owners.rows.map(owner => ({
            user_id: owner.id,
            company_id: owner.company_id,
            type: 'system_broadcast',
            title: title || 'System Announcement',
            message,
            priority: priority || 'medium'
        }));

        // Batch insert or loop (simple loop for now as we don't have many companies yet)
        for (const note of notifications) {
            await pool.query(
                `INSERT INTO notifications (user_id, company_id, type, title, message, priority, read)
                 VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
                [note.user_id, note.company_id, note.type, note.title, note.message, note.priority]
            );
        }

        res.json({ message: `Broadcast sent to ${owners.rows.length} company owners` });
    } catch (err) {
        res.status(500).json({ message: 'Failed to broadcast announcement' });
    }
});

module.exports = router;
