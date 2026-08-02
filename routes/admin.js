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
// Platform-wide user list (UNION of Staff users and Customer accounts)
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT u.id::text, u.name, u.email, 'staff' AS user_type, u.role, u.company_id, u.created_at, c.company_name 
         FROM users u
         LEFT JOIN companies c ON u.company_id = c.id
         UNION ALL
         SELECT cust.id::text, cust.name, cust.email, 'customer' AS user_type, 'customer' AS role, cust.company_id, cust.created_at, c.company_name
         FROM customers cust
         LEFT JOIN companies c ON cust.company_id = c.id
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(`SELECT ((SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM customers))::int as total`)
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

// ─── GET /api/admin/companies/:id ────────────────────────────────────────────
// Get full detail for a specific company (for drilldown view)
router.get('/companies/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [companyRes, usersRes, planRes] = await Promise.all([
      pool.query(`
        SELECT c.*, u.name as owner_name, u.email as owner_email, u.phone as owner_phone,
               p.name as plan_name
        FROM companies c
        LEFT JOIN users u ON c.owner_id = u.id
        LEFT JOIN plans p ON c.plan_id = p.id
        WHERE c.id = $1
      `, [id]),
      pool.query(`
        SELECT id, name, email, role, created_at FROM users WHERE company_id = $1 ORDER BY created_at DESC
      `, [id]),
      pool.query(`SELECT * FROM plans ORDER BY id`)
    ]);

    if (companyRes.rows.length === 0) return res.status(404).json({ message: 'Company not found' });

    res.json({
      company: companyRes.rows[0],
      users: usersRes.rows,
      plans: planRes.rows
    });
  } catch (err) {
    console.error('❌ Company detail error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/revenue ──────────────────────────────────────────────────
// Platform revenue analytics (MRR, ARR, plan breakdown)
router.get('/revenue', async (req, res) => {
  try {
    // Plan pricing (define here, can be moved to DB later)
    const PLAN_PRICING = { 1: 0, 2: 999, 3: 2499 }; // Free, Basic, Pro (monthly ₹)

    const [planDist, recentUpgrades, churnData, monthlyRevenue] = await Promise.all([
      // Active subscriptions by plan
      pool.query(`
        SELECT p.id as plan_id, p.name as plan_name, COUNT(c.id) as company_count
        FROM companies c
        JOIN plans p ON c.plan_id = p.id
        WHERE c.status != 'suspended' OR c.status IS NULL
        GROUP BY p.id, p.name
        ORDER BY p.id
      `),
      // Recent upgrades (last 30 days)
      pool.query(`
        SELECT c.company_name, p.name as plan_name, c.updated_at
        FROM companies c
        JOIN plans p ON c.plan_id = p.id
        WHERE c.plan_id > 1 AND c.updated_at > NOW() - INTERVAL '30 days'
        ORDER BY c.updated_at DESC
        LIMIT 10
      `),
      // Churned (expired subscriptions)
      pool.query(`
        SELECT COUNT(*) as churned
        FROM companies
        WHERE subscription_expires_at < NOW() AND plan_id > 1
      `),
      // Monthly revenue trend (last 6 months by company creation date as proxy)
      pool.query(`
        SELECT 
          TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') as month,
          COUNT(*) FILTER (WHERE plan_id = 2) as basic_count,
          COUNT(*) FILTER (WHERE plan_id = 3) as pro_count
        FROM companies
        WHERE created_at > NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at) ASC
      `)
    ]);

    // Calculate MRR
    let mrr = 0;
    const planBreakdown = planDist.rows.map(row => {
      const price = PLAN_PRICING[row.plan_id] || 0;
      const revenue = price * parseInt(row.company_count);
      mrr += revenue;
      return {
        plan: row.plan_name,
        count: parseInt(row.company_count),
        price,
        revenue
      };
    });

    res.json({
      mrr,
      arr: mrr * 12,
      planBreakdown,
      recentUpgrades: recentUpgrades.rows,
      churned: parseInt(churnData.rows[0]?.churned || 0),
      monthlyTrend: monthlyRevenue.rows.map(r => ({
        month: r.month,
        basicRevenue: parseInt(r.basic_count) * PLAN_PRICING[2],
        proRevenue: parseInt(r.pro_count) * PLAN_PRICING[3],
        total: parseInt(r.basic_count) * PLAN_PRICING[2] + parseInt(r.pro_count) * PLAN_PRICING[3]
      }))
    });
  } catch (err) {
    console.error('❌ Revenue analytics error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/health ───────────────────────────────────────────────────
// Detailed platform health & system integration diagnostics
router.get('/health', async (req, res) => {
  try {
    const start = Date.now();
    
    // 1. Database Health Check
    const dbCheck = await pool.query('SELECT NOW() as db_time').then(r => ({ ok: true, time: r.rows[0].db_time })).catch(e => ({ ok: false, error: e.message }));
    const dbLatencyMs = Date.now() - start;

    // 2. Auxiliary Metrics
    const [activeCompanies, activeUsers, recentErrors, suspendedCount] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM companies WHERE status != 'suspended' OR status IS NULL"),
      pool.query("SELECT COUNT(DISTINCT user_id) as count FROM activities WHERE created_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*) as count FROM feedback WHERE created_at > NOW() - INTERVAL '24 hours' AND type = 'bug'"),
      pool.query("SELECT COUNT(*) as count FROM companies WHERE status = 'suspended'")
    ]);

    // 3. Integration Diagnostic Checks
    const integrations = {
      database: {
        status: dbCheck.ok ? 'operational' : 'degraded',
        latencyMs: dbLatencyMs,
        dbTime: dbCheck.time || null
      },
      redis: {
        status: process.env.REDIS_URL ? 'configured' : 'fallback_memory',
        description: process.env.REDIS_URL ? 'Redis cluster connected' : 'In-memory rate limiter & session store fallback'
      },
      cloudinary: {
        status: (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) ? 'configured' : 'not_configured',
        cloudName: process.env.CLOUDINARY_CLOUD_NAME || null
      },
      firebase: {
        status: (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_CONFIG) ? 'configured' : 'not_configured',
        fcm: 'Push notification engine ready'
      },
      razorpay: {
        status: (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) ? 'configured' : 'not_configured',
        mode: process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live') ? 'live' : 'test'
      },
      email_service: {
        status: process.env.RESEND_API_KEY ? 'configured' : 'smtp_fallback',
        provider: process.env.RESEND_API_KEY ? 'Resend API' : 'SMTP Transport'
      },
      storage: {
        status: 'operational',
        provider: process.env.CLOUDINARY_CLOUD_NAME ? 'Cloudinary + Local' : 'Local Disk'
      },
      workers: {
        status: 'operational',
        poller: 'Active background task runner'
      }
    };

    const overallStatus = dbCheck.ok ? 'operational' : 'degraded';

    res.json({
      status: overallStatus,
      dbLatencyMs,
      dbTime: dbCheck.time,
      activeCompanies: parseInt(activeCompanies.rows[0].count),
      activeUsersLast24h: parseInt(activeUsers.rows[0].count),
      bugReportsLast24h: parseInt(recentErrors.rows[0].count),
      suspendedCompanies: parseInt(suspendedCount.rows[0].count),
      integrations,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      status: 'degraded',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ─── GET /api/admin/users (extended with search) ─────────────────────────────
// Enhanced platform-wide user list with search and role filter

// ─── GET /api/admin/users/search ─────────────────────────────────────────────
router.get('/users/search', async (req, res) => {
  try {
    const { q, role, company } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (q) {
      whereClause += ` AND (u.name ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx})`;
      params.push(`%${q}%`);
      paramIdx++;
    }
    if (role && role !== 'all') {
      whereClause += ` AND u.role = $${paramIdx}`;
      params.push(role);
      paramIdx++;
    }
    if (company) {
      whereClause += ` AND c.company_name ILIKE $${paramIdx}`;
      params.push(`%${company}%`);
      paramIdx++;
    }

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.created_at, c.company_name, c.id as company_id
         FROM users u
         LEFT JOIN companies c ON u.company_id = c.id
         ${whereClause}
         ORDER BY u.created_at DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) as total FROM users u LEFT JOIN companies c ON u.company_id = c.id ${whereClause}`,
        params
      )
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
    console.error('❌ User search error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/audit-trail ──────────────────────────────────────────────
// Platform-wide admin action audit trail
router.get('/audit-trail', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const offset = (page - 1) * limit;

    const result = await pool.query(`
      SELECT 
        a.id, a.action, a.created_at,
        u.name as user_name, u.email, u.role,
        c.company_name
      FROM activities a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN companies c ON a.company_id = c.id
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const countResult = await pool.query('SELECT COUNT(*) as total FROM activities');

    res.json({
      activities: result.rows,
      pagination: {
        page, limit,
        total: parseInt(countResult.rows[0].total),
        pages: Math.ceil(countResult.rows[0].total / limit)
      }
    });
  } catch (err) {
    console.error('❌ Audit trail error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PATCH /api/admin/companies/:id/plan ─────────────────────────────────────
// Quick plan override (alternative to /subscriptions/:companyId, takes company.id not companyId)
router.patch('/companies/:id/plan', async (req, res) => {
  const { id } = req.params;
  const { plan_id, expires_at, note } = req.body;

  if (!plan_id) return res.status(400).json({ message: 'plan_id is required' });

  try {
    const result = await pool.query(
      `UPDATE companies 
       SET plan_id = $1, subscription_expires_at = $2, is_on_trial = FALSE, 
           subscription_status = 'active', updated_at = NOW()
       WHERE id = $3 RETURNING id, company_name, plan_id`,
      [plan_id, expires_at || null, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Company not found' });
    
    console.log(`🛡️ SuperAdmin plan override: company ${id} → plan ${plan_id}${note ? ` (${note})` : ''}`);
    res.json({ ok: true, company: result.rows[0] });
  } catch (err) {
    console.error('❌ Plan override error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PATCH /api/admin/companies/:id ──────────────────────────────────────────
// Edit company details (name, address, contact_email, phone)
router.patch('/companies/:id', async (req, res) => {
  const { id } = req.params;
  const { company_name, address, contact_email, phone } = req.body;

  const updates = [];
  const values = [];
  let idx = 1;

  if (company_name) { updates.push(`company_name = $${idx++}`); values.push(company_name.trim()); }
  if (address !== undefined) { updates.push(`address = $${idx++}`); values.push(address); }
  if (contact_email !== undefined) { updates.push(`contact_email = $${idx++}`); values.push(contact_email); }
  if (phone !== undefined) { updates.push(`phone = $${idx++}`); values.push(phone); }

  if (updates.length === 0) return res.status(400).json({ message: 'No fields provided to update' });

  updates.push(`updated_at = NOW()`);
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE companies SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, company_name, address, contact_email, updated_at`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Company not found' });
    res.json({ ok: true, company: result.rows[0] });
  } catch (err) {
    console.error('❌ Company edit error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── DELETE /api/admin/companies/:id ─────────────────────────────────────────
// Permanently delete a company and all associated data (irreversible)
router.delete('/companies/:id', async (req, res) => {
  const { id } = req.params;
  const { confirm } = req.body;

  if (confirm !== 'DELETE') {
    return res.status(400).json({ message: 'Body must include { confirm: "DELETE" } to prevent accidental deletion' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Get company info for logging
    const co = await client.query('SELECT company_name, company_id FROM companies WHERE id = $1', [id]);
    if (co.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Company not found' });
    }

    const { company_name, company_id } = co.rows[0];

    // Delete in dependency order
    await client.query('DELETE FROM notifications WHERE company_id = $1', [id]);
    await client.query('DELETE FROM activities WHERE company_id = $1', [id]);
    await client.query('DELETE FROM feedback WHERE company_id = $1', [id]);
    await client.query('DELETE FROM users WHERE company_id = $1', [id]);
    await client.query('DELETE FROM companies WHERE id = $1', [id]);

    await client.query('COMMIT');

    console.log(`🛡️ SuperAdmin DELETED company: ${company_name} (${company_id}), id=${id}`);
    res.json({ ok: true, message: `Company "${company_name}" permanently deleted` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Company delete error:', err);
    res.status(500).json({ message: 'Server error during deletion' });
  } finally {
    client.release();
  }
});

// ─── GET /api/admin/companies/:id/usage ──────────────────────────────────────
// Per-company usage statistics
router.get('/companies/:id/usage', async (req, res) => {
  const { id } = req.params;
  try {
    const [employees, jobs, inventory, activities7d, messages] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM users WHERE company_id = $1 AND role = 'employee'", [id]),
      pool.query("SELECT COUNT(*) as count FROM jobs WHERE company_id = $1", [id]).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query("SELECT COUNT(*) as count FROM inventory WHERE company_id = $1", [id]).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query("SELECT COUNT(*) as count FROM activities WHERE company_id = $1 AND created_at > NOW() - INTERVAL '7 days'", [id]),
      pool.query("SELECT COUNT(*) as count FROM messages WHERE company_id = $1", [id]).catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    res.json({
      employees: parseInt(employees.rows[0].count),
      jobs: parseInt(jobs.rows[0].count),
      inventory: parseInt(inventory.rows[0].count),
      activities7d: parseInt(activities7d.rows[0].count),
      messages: parseInt(messages.rows[0].count),
    });
  } catch (err) {
    console.error('❌ Company usage error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/users/:id ─────────────────────────────────────────────────
// Get a specific user's details
router.get('/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.phone, u.position, u.department,
              u.created_at, u.is_active, c.company_name, c.id as company_id
       FROM users u
       LEFT JOIN companies c ON u.company_id::text = c.id::text
       WHERE u.id::text = $1::text`,
      [id]
    );
    if (r.rows.length > 0) return res.json(r.rows[0]);

    // Fallback: Check customers table for customer accounts
    const cust = await pool.query(
      `SELECT c.id, c.name, c.email, 'customer' AS role, c.phone, NULL AS position, NULL AS department,
              c.created_at, TRUE AS is_active, comp.company_name, comp.id AS company_id
       FROM customers c
       LEFT JOIN companies comp ON c.company_id::text = comp.id::text
       WHERE c.id::text = $1::text`,
      [id]
    );
    if (cust.rows.length > 0) return res.json(cust.rows[0]);

    return res.status(404).json({ message: 'User not found' });
  } catch (err) {
    console.error('GET /api/admin/users/:id error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PATCH /api/admin/users/:id ──────────────────────────────────────────────
// Edit user details (name, role, is_active)
router.patch('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, role, is_active, phone, position, department } = req.body;

  const validRoles = ['owner', 'hr', 'employee', 'admin'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ message: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
  }

  const updates = [];
  const values = [];
  let idx = 1;

  if (name) { updates.push(`name = $${idx++}`); values.push(name.trim()); }
  if (role) { updates.push(`role = $${idx++}`); values.push(role); }
  if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); values.push(Boolean(is_active)); }
  if (phone !== undefined) { updates.push(`phone = $${idx++}`); values.push(phone); }
  if (position !== undefined) { updates.push(`position = $${idx++}`); values.push(position); }
  if (department !== undefined) { updates.push(`department = $${idx++}`); values.push(department); }

  if (updates.length === 0) return res.status(400).json({ message: 'No fields provided to update' });
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, name, email, role, is_active`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error('❌ User edit error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── DELETE /api/admin/users/:id ─────────────────────────────────────────────
// Soft delete (deactivate) or hard delete a user
router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { hard_delete } = req.body;

  try {
    if (hard_delete === true) {
      // Hard delete — check user is not the only owner
      const user = await pool.query('SELECT role, company_id FROM users WHERE id = $1', [id]);
      if (user.rows.length === 0) return res.status(404).json({ message: 'User not found' });

      if (user.rows[0].role === 'owner') {
        const ownerCount = await pool.query(
          "SELECT COUNT(*) as c FROM users WHERE company_id = $1 AND role = 'owner'",
          [user.rows[0].company_id]
        );
        if (parseInt(ownerCount.rows[0].c) <= 1) {
          return res.status(400).json({ message: 'Cannot delete the sole owner of a company. Transfer ownership first.' });
        }
      }

      await pool.query('DELETE FROM users WHERE id = $1', [id]);
      res.json({ ok: true, deleted: true });
    } else {
      // Soft delete — just deactivate
      const result = await pool.query(
        'UPDATE users SET is_active = FALSE WHERE id = $1 RETURNING id, name, email, is_active',
        [id]
      );
      if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
      res.json({ ok: true, user: result.rows[0], message: 'User deactivated (soft delete)' });
    }
  } catch (err) {
    console.error('❌ User delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /api/admin/users/:id/reset-password ────────────────────────────────
// Admin-initiated password reset for any user
router.post('/users/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  const { new_password } = req.body;

  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ message: 'new_password must be at least 8 characters' });
  }

  try {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(new_password, 12);

    const result = await pool.query(
      'UPDATE users SET password_hash = $1, password_set = TRUE WHERE id = $2 RETURNING id, name, email',
      [hash, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });

    // Revoke all refresh tokens for security
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [id]).catch(() => {});

    console.log(`🛡️ SuperAdmin reset password for user: ${result.rows[0].email}`);
    res.json({ ok: true, message: `Password reset for ${result.rows[0].name}` });
  } catch (err) {
    console.error('❌ Password reset error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/announcements ────────────────────────────────────────────
// List all stored announcements (uses the announcements table)
router.get('/announcements', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;

  try {
    const [result, count] = await Promise.all([
      pool.query(`
        SELECT a.*, u.name as created_by_name, u.email as created_by_email
        FROM announcements a
        LEFT JOIN users u ON a.created_by = u.id
        ORDER BY a.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query('SELECT COUNT(*) as total FROM announcements')
    ]);

    res.json({
      announcements: result.rows,
      pagination: { page, limit, total: parseInt(count.rows[0].total), pages: Math.ceil(count.rows[0].total / limit) }
    });
  } catch (err) {
    console.error('❌ Announcements list error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── DELETE /api/admin/announcements/:id ─────────────────────────────────────
router.delete('/announcements/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM announcements WHERE id = $1 RETURNING id, title', [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Announcement not found' });
    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/subscriptions/history ────────────────────────────────────
// Subscription history across all companies (payment history proxy)
router.get('/subscriptions/history', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  const offset = (page - 1) * limit;

  try {
    const [result, count] = await Promise.all([
      pool.query(`
        SELECT s.*, c.company_name, p.name as plan_name
        FROM subscriptions s
        JOIN companies c ON s.company_id = c.id
        JOIN plans p ON s.plan_id = p.id
        ORDER BY s.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query('SELECT COUNT(*) as total FROM subscriptions')
    ]);

    res.json({
      history: result.rows,
      pagination: { page, limit, total: parseInt(count.rows[0].total), pages: Math.ceil(count.rows[0].total / limit) }
    });
  } catch (err) {
    console.error('❌ Subscription history error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/system/status ─────────────────────────────────────────────
// Get current system maintenance & platform status
router.get('/system/status', async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT value FROM system_settings WHERE key = 'maintenance_mode'"
    ).catch(() => ({ rows: [] }));

    const setting = r.rows[0]?.value || {
      mode: 'disabled', // 'disabled' (normal live), 'enabled' (maintenance), 'read_only', 'emergency'
      message: 'Platform is operating normally.',
      updated_at: new Date().toISOString()
    };

    res.json(setting);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /api/admin/system/maintenance ──────────────────────────────────────
// Update system maintenance mode
router.post('/system/maintenance', async (req, res) => {
  const { mode, message } = req.body;
  const validModes = ['disabled', 'enabled', 'read_only', 'emergency'];

  if (!mode || !validModes.includes(mode)) {
    return res.status(400).json({ message: `Invalid mode. Must be one of: ${validModes.join(', ')}` });
  }

  try {
    const value = {
      mode,
      message: message || (mode === 'disabled' ? 'Platform is operating normally.' : 'System maintenance is in progress.'),
      updated_at: new Date().toISOString(),
      updated_by: req.user?.email || 'admin@prozync.in'
    };

    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `).catch(() => {});

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('maintenance_mode', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [value]
    );

    console.log(`🛡️ SuperAdmin updated Maintenance Mode: ${mode} ("${value.message}")`);
    res.json({ ok: true, maintenance: value });
  } catch (err) {
    console.error('❌ Maintenance mode error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/logs/error ────────────────────────────────────────────────
// Retrieve error logs from error_logs table or activity fallback
router.get('/logs/error', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  const offset = (page - 1) * limit;

  try {
    const [result, count] = await Promise.all([
      pool.query(`
        SELECT * FROM error_logs 
        ORDER BY created_at DESC 
        LIMIT $1 OFFSET $2
      `, [limit, offset]).catch(() => ({ rows: [] })),
      pool.query('SELECT COUNT(*) as total FROM error_logs').catch(() => ({ rows: [{ total: 0 }] }))
    ]);

    res.json({
      logs: result.rows,
      pagination: { page, limit, total: parseInt(count.rows[0].total), pages: Math.ceil(count.rows[0].total / limit) }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/logs/login ────────────────────────────────────────────────
// Retrieve user & customer login logs from activities
router.get('/logs/login', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  const offset = (page - 1) * limit;

  try {
    const [result, count] = await Promise.all([
      pool.query(`
        SELECT a.id, a.action, a.created_at, a.ip_address, u.name as user_name, u.email, u.role, c.company_name
        FROM activities a
        LEFT JOIN users u ON a.user_id = u.id
        LEFT JOIN companies c ON a.company_id = c.id
        WHERE a.action IN ('login', 'login_google', 'customer_login', 'customer_login_success', 'logout', 'customer_logout')
        ORDER BY a.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query(`
        SELECT COUNT(*) as total FROM activities 
        WHERE action IN ('login', 'login_google', 'customer_login', 'customer_login_success', 'logout', 'customer_logout')
      `)
    ]);

    res.json({
      logs: result.rows,
      pagination: { page, limit, total: parseInt(count.rows[0].total), pages: Math.ceil(count.rows[0].total / limit) }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /api/admin/users/:id/force-logout ──────────────────────────────────
// Force logout user by revoking all refresh tokens
router.post('/users/:id/force-logout', async (req, res) => {
  const { id } = req.params;
  try {
    const [tokens, custTokens] = await Promise.all([
      pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 RETURNING id', [id]),
      pool.query('UPDATE customer_refresh_tokens SET revoked = TRUE WHERE customer_id = $1 RETURNING id', [id]).catch(() => ({ rows: [] }))
    ]);

    const count = tokens.rows.length + custTokens.rows.length;
    console.log(`🛡️ SuperAdmin forced logout for user ${id}: ${count} token(s) revoked`);
    res.json({ ok: true, revokedCount: count, message: `Forced logout: ${count} active session(s) revoked` });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /api/admin/users/:id/restore ───────────────────────────────────────
// Restore (re-enable) a deactivated user
router.post('/users/:id/restore', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE users SET is_active = TRUE WHERE id = $1 RETURNING id, name, email, is_active',
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json({ ok: true, user: result.rows[0], message: 'User account restored' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/users/:id/login-history ──────────────────────────────────
// Get login history for a specific user
router.get('/users/:id/login-history', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`
      SELECT action, created_at, ip_address 
      FROM activities 
      WHERE user_id = $1 AND action IN ('login', 'login_google', 'logout')
      ORDER BY created_at DESC 
      LIMIT 20
    `, [id]);
    res.json({ history: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /api/admin/companies/:id/restore ───────────────────────────────────
// Restore a suspended company
router.post('/companies/:id/restore', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "UPDATE companies SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING id, company_name, status",
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Company not found' });
    res.json({ ok: true, company: result.rows[0], message: 'Company restored to active status' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/payments ──────────────────────────────────────────────────
// Payment transactions list
router.get('/payments', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  const offset = (page - 1) * limit;

  try {
    const [result, count] = await Promise.all([
      pool.query(`
        SELECT s.id, s.company_id, s.plan_id, s.start_date, s.end_date, s.status, s.created_at,
               c.company_name, p.name as plan_name
        FROM subscriptions s
        LEFT JOIN companies c ON s.company_id = c.id
        LEFT JOIN plans p ON s.plan_id = p.id
        ORDER BY s.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query('SELECT COUNT(*) as total FROM subscriptions')
    ]);

    res.json({
      payments: result.rows,
      pagination: { page, limit, total: parseInt(count.rows[0].total), pages: Math.ceil(count.rows[0].total / limit) }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /api/admin/payments/:id/refund ─────────────────────────────────────
// Record payment refund
router.post('/payments/:id/refund', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const result = await pool.query(
      `UPDATE subscriptions SET status = 'refunded' WHERE id = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Transaction not found' });

    console.log(`🛡️ SuperAdmin refunded payment ${id}: ${reason || 'Admin refund'}`);
    res.json({ ok: true, payment: result.rows[0], message: 'Payment marked as refunded' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;



