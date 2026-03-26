const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { authenticateSuperAdmin } = require('../middleware/adminMiddleware');

// All routes in this file require both a valid token AND super_admin privileges
router.use(authenticateToken);
router.use(authenticateSuperAdmin);

// ─── GET /api/admin/dashboard ────────────────────────────────────────────────
// Aggregate platform-wide statistics for the Overview page
router.get('/dashboard', async (req, res) => {
  try {
    // 1. Basic Stats + MoM Growth
    const statsQuery = pool.query(`
      WITH monthly_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as new_companies_30d,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '60 days' AND created_at <= NOW() - INTERVAL '30 days') as new_companies_prev_30d,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as new_users_30d,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '60 days' AND created_at <= NOW() - INTERVAL '30 days') as new_users_prev_30d
        FROM companies
      ),
      user_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as new_users_30d,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '60 days' AND created_at <= NOW() - INTERVAL '30 days') as new_users_prev_30d
        FROM users
      )
      SELECT 
        (SELECT COUNT(*) FROM companies) as total_companies,
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM companies WHERE plan_id > 1 AND (subscription_expires_at > NOW() OR subscription_expires_at IS NULL)) as active_subs,
        (SELECT COUNT(*) FROM companies WHERE is_on_trial = TRUE) as trial_users,
        (SELECT COUNT(*) FROM activities WHERE created_at > NOW() - INTERVAL '24 hours') as activity_24h,
        (SELECT COUNT(DISTINCT user_id) FROM activities WHERE created_at > NOW() - INTERVAL '30 days') as active_users_30d,
        m.new_companies_30d,
        m.new_companies_prev_30d,
        u.new_users_30d,
        u.new_users_prev_30d
      FROM monthly_stats m, user_stats u
    `);
    
    // 2. Company Growth (Last 30 days)
    const growthQuery = pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count
      FROM companies
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `);

    // 3. User Growth (Last 30 days)
    const userGrowthQuery = pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count
      FROM users
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `);

    // 4. Subscription Distribution
    const distQuery = pool.query(`
      SELECT 
        COALESCE(p.name, 'Free') as name,
        COUNT(c.id) as value
      FROM companies c
      LEFT JOIN plans p ON c.plan_id = p.id
      GROUP BY p.name
    `);

    // 5. Recent System Pulse (10 latest activities)
    const pulseQuery = pool.query(`
      SELECT 
        a.*, 
        u.name as user_name,
        c.company_name
      FROM activities a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN companies c ON a.company_id = c.id
      ORDER BY a.created_at DESC
      LIMIT 10
    `);

    const [stats, growth, userGrowth, dist, pulse] = await Promise.all([
      statsQuery, growthQuery, userGrowthQuery, distQuery, pulseQuery
    ]);

    const s = stats.rows[0];
    
    // Calculate percentage growth safely
    const calcGrowth = (current, prev) => {
      if (prev === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - prev) / prev) * 100);
    };

    res.json({
      stats: {
        totalCompanies: parseInt(s.total_companies),
        totalUsers: parseInt(s.total_users),
        activeSubscriptions: parseInt(s.active_subs),
        trialUsers: parseInt(s.trial_users),
        recentActivity24h: parseInt(s.activity_24h),
        activeUsers30d: parseInt(s.active_users_30d),
        companyGrowthMoM: calcGrowth(parseInt(s.new_companies_30d), parseInt(s.new_companies_prev_30d)),
        userGrowthMoM: calcGrowth(parseInt(s.new_users_30d), parseInt(s.new_users_prev_30d))
      },
      charts: {
        companyGrowth: growth.rows.map(r => ({ date: r.date.toISOString().split('T')[0], count: parseInt(r.count) })),
        userGrowth: userGrowth.rows.map(r => ({ date: r.date.toISOString().split('T')[0], count: parseInt(r.count) })),
        subscriptionDistribution: dist.rows.map(r => ({ name: r.name, value: parseInt(r.value) }))
      },
      pulse: pulse.rows,
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
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.created_at, c.company_name 
         FROM users u
         LEFT JOIN companies c ON u.company_id = c.id
         ORDER BY u.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query('SELECT COUNT(*) as total FROM users')
    ]);

    res.json({
      users: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].total),
        pages: Math.ceil(countResult.rows[0].total / limit)
      }
    });
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

    if (!message || !message.trim()) {
      return res.status(400).json({ message: 'Announcement message is required' });
    }

    try {
        // Fetch all company owners in a single query
        const owners = await pool.query("SELECT id, company_id FROM users WHERE role = 'owner'");
        
        if (owners.rows.length === 0) {
          return res.json({ message: 'No company owners found to notify', sent: 0 });
        }

        // Batch INSERT all notifications in a single query using unnest for efficiency
        const userIds = owners.rows.map(o => o.id);
        const companyIds = owners.rows.map(o => o.company_id);
        const noteTitle = title || 'System Announcement';
        const notePriority = priority || 'medium';

        await pool.query(
          `INSERT INTO notifications (user_id, company_id, type, title, message, priority, read)
           SELECT unnest($1::uuid[]), unnest($2::int[]), $3, $4, $5, $6, FALSE`,
          [userIds, companyIds, 'system_broadcast', noteTitle, message, notePriority]
        );

        res.json({ message: `Broadcast sent to ${owners.rows.length} company owners`, sent: owners.rows.length });
    } catch (err) {
        console.error('❌ Announcement broadcast error:', err);
        res.status(500).json({ message: 'Failed to broadcast announcement' });
    }
});

module.exports = router;
