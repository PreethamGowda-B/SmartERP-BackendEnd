/**
 * scripts/superadmin-production-audit.js
 * 
 * Comprehensive production audit of the Super Admin Portal.
 * Runs against the real production database.
 */

require('dotenv').config();
const { pool } = require('../db');
const bcrypt = require('bcrypt');

const results = {
  passed: [],
  failed: [],
  warnings: [],
};

function pass(name, detail = '') {
  results.passed.push({ name, detail });
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}

function fail(name, detail = '') {
  results.failed.push({ name, detail });
  console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
}

function warn(name, detail = '') {
  results.warnings.push({ name, detail });
  console.warn(`  ⚠️  ${name}${detail ? ' — ' + detail : ''}`);
}

async function run() {
  console.log('\n================================================');
  console.log('  SmartERP Super Admin — Production Audit');
  console.log('================================================\n');

  // ─── 1. SUPER ADMIN ACCOUNT ─────────────────────────────────────────────────
  console.log('📋 [1] Super Admin Account Verification');
  try {
    const email = process.env.SUPER_ADMIN_EMAIL || 'admin@prozync.in';
    const password = process.env.SUPER_ADMIN_PASSWORD || 'admin@preethu4959';

    const res = await pool.query('SELECT id, email, role, name, password_hash FROM users WHERE email = $1', [email]);
    
    if (res.rows.length === 0) {
      fail('Admin account exists', `${email} NOT found in database`);
    } else {
      const user = res.rows[0];
      pass('Admin account exists', `id=${user.id}`);
      
      if (user.role === 'super_admin') {
        pass('Role is super_admin');
      } else {
        fail('Role is super_admin', `actual role: ${user.role}`);
      }

      if (user.password_hash) {
        const match = await bcrypt.compare(password, user.password_hash);
        if (match) {
          pass('Password hash is correct', 'bcrypt.compare → true');
        } else {
          fail('Password hash is correct', 'bcrypt.compare returned false — password mismatch!');
        }
        
        const cost = parseInt(user.password_hash.split('$')[2]);
        if (cost >= 10) {
          pass('Password cost factor', `bcrypt rounds: ${cost}`);
        } else {
          warn('Password cost factor', `rounds: ${cost} (recommend >= 12)`);
        }
      } else {
        fail('Password hash exists', 'password_hash is NULL');
      }
    }
  } catch (e) {
    fail('Admin account check', e.message);
  }

  // ─── 2. TABLES VERIFICATION ──────────────────────────────────────────────────
  console.log('\n📋 [2] Critical Tables & Schema');
  const requiredTables = ['users', 'companies', 'plans', 'activities', 'notifications', 'feedback', 'refresh_tokens'];
  for (const table of requiredTables) {
    try {
      const r = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);
      pass(`Table: ${table}`, `${r.rows[0].count} rows`);
    } catch (e) {
      fail(`Table: ${table}`, e.message);
    }
  }

  // Check ai_audit_logs
  try {
    const r = await pool.query('SELECT COUNT(*) as count FROM ai_audit_logs');
    pass('Table: ai_audit_logs', `${r.rows[0].count} rows`);
  } catch (e) {
    warn('Table: ai_audit_logs', 'table may not exist yet — AI logs will fail');
  }

  // ─── 3. ADMIN ENDPOINTS DATA CHECK ───────────────────────────────────────────
  console.log('\n📋 [3] Admin API Data Checks');

  // Dashboard
  try {
    const r = await pool.query('SELECT COUNT(*) as co FROM companies');
    const u = await pool.query('SELECT COUNT(*) as us FROM users');
    const a = await pool.query("SELECT COUNT(*) as ac FROM activities WHERE created_at > NOW() - INTERVAL '24 hours'");
    pass('Dashboard data', `companies=${r.rows[0].co}, users=${u.rows[0].us}, activity24h=${a.rows[0].ac}`);
  } catch(e) { fail('Dashboard data', e.message); }

  // Revenue endpoint data
  try {
    const r = await pool.query('SELECT id, name FROM plans ORDER BY id');
    pass('Plans table', r.rows.map(p => `${p.id}:${p.name}`).join(', '));
  } catch(e) { fail('Plans table', e.message); }

  // Companies with plans
  try {
    const r = await pool.query(`
      SELECT p.name, COUNT(c.id) as count
      FROM companies c LEFT JOIN plans p ON c.plan_id = p.id
      GROUP BY p.name ORDER BY p.name
    `);
    pass('Plan distribution', r.rows.map(x => `${x.name}:${x.count}`).join(', '));
  } catch(e) { fail('Plan distribution', e.message); }

  // Company status column
  try {
    const r = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'companies' AND column_name = 'status'
    `);
    if (r.rows.length > 0) {
      pass('companies.status column exists', r.rows[0].data_type);
    } else {
      fail('companies.status column', 'column does not exist');
    }
  } catch(e) { fail('companies.status check', e.message); }

  // ─── 4. SECURITY RBAC CHECKS ─────────────────────────────────────────────────
  console.log('\n📋 [4] Security & RBAC');

  // Check middleware files exist
  const fs = require('fs');
  const path = require('path');
  
  const middlewares = [
    '../middleware/adminMiddleware.js',
    '../middleware/authMiddleware.js',
    '../middleware/planMiddleware.js',
  ];
  for (const mw of middlewares) {
    try {
      const loaded = require(path.join(__dirname, mw));
      if (loaded) {
        pass(`Middleware: ${path.basename(mw)}`, 'loaded successfully');
      }
    } catch(e) {
      fail(`Middleware: ${path.basename(mw)}`, e.message);
    }
  }

  // Verify admin routes require authenticateSuperAdmin
  try {
    const adminRoute = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
    if (adminRoute.includes('authenticateToken') && adminRoute.includes('authenticateSuperAdmin')) {
      pass('Admin routes use double middleware', 'authenticateToken + authenticateSuperAdmin');
    } else {
      fail('Admin routes middleware', 'missing auth middleware');
    }
    if (adminRoute.includes("router.use(authenticateToken)") && adminRoute.includes("router.use(authenticateSuperAdmin)")) {
      pass('Router-level middleware (blocks ALL routes)');
    } else {
      warn('Router-level middleware', 'may use per-route middleware instead');
    }
  } catch(e) { fail('Admin route security check', e.message); }

  // ─── 5. MISSING FEATURES CHECK ───────────────────────────────────────────────
  console.log('\n📋 [5] Feature Completeness Check');

  const adminRouteContent = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');

  const features = [
    { name: 'GET /admin/dashboard', pattern: "router.get('/dashboard'" },
    { name: 'GET /admin/companies', pattern: "router.get('/companies'" },
    { name: 'GET /admin/companies/:id', pattern: "router.get('/companies/:id'" },
    { name: 'PATCH /admin/companies/:id/status', pattern: "router.patch('/companies/:id/status'" },
    { name: 'PATCH /admin/companies/:id/plan', pattern: "router.patch('/companies/:id/plan'" },
    { name: 'GET /admin/users', pattern: "router.get('/users'" },
    { name: 'GET /admin/users/search', pattern: "router.get('/users/search'" },
    { name: 'GET /admin/revenue', pattern: "router.get('/revenue'" },
    { name: 'GET /admin/health', pattern: "router.get('/health'" },
    { name: 'GET /admin/audit-trail', pattern: "router.get('/audit-trail'" },
    { name: 'POST /admin/announcements', pattern: "router.post('/announcements'" },
    { name: 'PATCH /admin/subscriptions/:id', pattern: "router.patch('/subscriptions/" },
  ];

  const missing = [];
  for (const f of features) {
    if (adminRouteContent.includes(f.pattern)) {
      pass(`Endpoint: ${f.name}`);
    } else {
      fail(`Endpoint: ${f.name}`, 'NOT FOUND in admin.js');
      missing.push(f.name);
    }
  }

  // Check for NOT-YET-IMPLEMENTED features
  const notImplemented = [
    { name: 'DELETE /admin/companies/:id', desc: 'Company deletion' },
    { name: 'PATCH /admin/companies/:id', desc: 'Company edit (name, address, etc)' },
    { name: 'POST /admin/users', desc: 'Create user from admin' },
    { name: 'DELETE /admin/users/:id', desc: 'Delete user' },
    { name: 'PATCH /admin/users/:id', desc: 'Edit user (name, role)' },
    { name: 'POST /admin/users/:id/reset-password', desc: 'Admin password reset' },
    { name: 'GET /admin/companies/:id/usage', desc: 'Per-company usage stats' },
    { name: 'GET /admin/payments', desc: 'Payment history' },
    { name: 'DELETE /admin/announcements/:id', desc: 'Delete announcement' },
  ];
  
  console.log('\n  📝 Not-yet-implemented (needed for full audit)');
  for (const ni of notImplemented) {
    warn(`Missing: ${ni.name}`, ni.desc);
  }

  // ─── 6. DATABASE INDEXES ─────────────────────────────────────────────────────
  console.log('\n📋 [6] Database Indexes');
  try {
    const r = await pool.query(`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE tablename IN ('users', 'companies', 'activities', 'feedback', 'notifications', 'ai_audit_logs')
      ORDER BY tablename, indexname
    `);
    const byTable = {};
    for (const row of r.rows) {
      if (!byTable[row.tablename]) byTable[row.tablename] = [];
      byTable[row.tablename].push(row.indexname);
    }
    for (const [table, indexes] of Object.entries(byTable)) {
      pass(`Indexes on ${table}`, indexes.join(', '));
    }

    // Check for missing critical indexes
    const indexDefs = r.rows.map(r => r.indexdef).join(' ');
    
    if (indexDefs.includes('users') && indexDefs.includes('email')) {
      pass('users.email index exists');
    } else {
      warn('users.email index', 'may be missing — login queries will be slow at scale');
    }
    
    if (indexDefs.includes('activities') && indexDefs.includes('created_at')) {
      pass('activities.created_at index');
    } else {
      warn('activities.created_at index', 'missing — audit trail queries will be slow');
    }
  } catch(e) { fail('Database indexes check', e.message); }

  // ─── 7. N+1 QUERY ANALYSIS ───────────────────────────────────────────────────
  console.log('\n📋 [7] N+1 Query Analysis');
  // Review critical queries
  if (adminRouteContent.includes('LEFT JOIN users') && adminRouteContent.includes('LEFT JOIN plans')) {
    pass('Companies list uses JOINs', 'no N+1 — owner and plan in single query');
  }
  if (adminRouteContent.includes('Promise.all')) {
    pass('Parallel queries used', 'Promise.all for concurrent DB calls');
  }

  // ─── 8. FEEDBACK TABLE CHECK ─────────────────────────────────────────────────
  console.log('\n📋 [8] Feedback System');
  try {
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'feedback' ORDER BY ordinal_position
    `);
    const colNames = cols.rows.map(c => c.column_name);
    pass('Feedback columns', colNames.join(', '));
    
    const needed = ['status', 'admin_reply', 'type', 'subject', 'message', 'user_id'];
    for (const col of needed) {
      if (colNames.includes(col)) {
        pass(`feedback.${col} column`);
      } else {
        fail(`feedback.${col} column`, 'MISSING');
      }
    }
  } catch(e) { fail('Feedback schema check', e.message); }

  // ─── 9. REFRESH TOKENS CHECK ────────────────────────────────────────────────
  console.log('\n📋 [9] Session Management');
  try {
    const r = await pool.query(`
      SELECT COUNT(*) as active, COUNT(*) FILTER (WHERE revoked = true) as revoked
      FROM refresh_tokens
      WHERE expires_at > NOW()
    `);
    pass('Refresh tokens table', `active=${r.rows[0].active}, revoked=${r.rows[0].revoked}`);
  } catch(e) { fail('Refresh tokens', e.message); }

  // ─── 10. ACTIVITIES TABLE ────────────────────────────────────────────────────
  console.log('\n📋 [10] Audit Trail Data');
  try {
    const r = await pool.query(`
      SELECT action, COUNT(*) as count 
      FROM activities 
      GROUP BY action 
      ORDER BY count DESC 
      LIMIT 10
    `);
    if (r.rows.length > 0) {
      pass('Activities table has data', r.rows.map(x => `${x.action}:${x.count}`).join(', '));
    } else {
      warn('Activities table', 'no records yet');
    }
  } catch(e) { fail('Activities table', e.message); }

  // ─── FINAL SUMMARY ──────────────────────────────────────────────────────────
  console.log('\n================================================');
  console.log('  AUDIT RESULTS');
  console.log('================================================');
  console.log(`  ✅ Passed:   ${results.passed.length}`);
  console.log(`  ❌ Failed:   ${results.failed.length}`);
  console.log(`  ⚠️  Warnings: ${results.warnings.length}`);

  if (results.failed.length > 0) {
    console.log('\n  FAILURES:');
    results.failed.forEach(f => console.log(`    ❌ ${f.name}: ${f.detail}`));
  }

  if (results.warnings.length > 0) {
    console.log('\n  WARNINGS:');
    results.warnings.forEach(w => console.log(`    ⚠️  ${w.name}: ${w.detail}`));
  }

  await pool.end();
  return results;
}

run().catch(e => { console.error('Audit script error:', e); process.exit(1); });
