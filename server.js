// back/server.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { pool } = require('./db');
const { ensureAll } = require('./dbSetup');

const app = express();

// Trust proxy (important on Render so secure cookies work)
app.set('trust proxy', 1);

// Basic middleware
app.use(express.json());
app.use(cookieParser());

// CORS: allow only your frontend origin and credentials
const FRONTEND = process.env.FRONTEND_ORIGIN || process.env.NEXT_PUBLIC_FRONTEND_URL || 'https://smart-erp-front-end.vercel.app';
app.use(cors({
  origin: FRONTEND,
  credentials: true
}));

// Helper to safely require route modules if they exist
function tryRequireRoute(relativePath) {
  const full = path.join(__dirname, relativePath);
  if (fs.existsSync(full + '.js') || fs.existsSync(full) ) {
    try {
      return require(full);
    } catch (err) {
      console.error(`Failed to require route ${relativePath}:`, err);
      return null;
    }
  }
  return null;
}

// Require route modules only if present
const authRoutes = tryRequireRoute('./routes/auth');
const employeesRoutes = tryRequireRoute('./routes/employees');
const jobsRoutes = tryRequireRoute('./routes/jobs');
const materialsRoutes = tryRequireRoute('./routes/materials');
const paymentsRoutes = tryRequireRoute('./routes/payments');
const attendanceRoutes = tryRequireRoute('./routes/attendance');
const activitiesRoutes = tryRequireRoute('./routes/activities');
const analyticsRoutes = tryRequireRoute('./routes/analytics');

// Mount routes under /api/* if the modules exist
if (authRoutes) {
  app.use('/api/auth', authRoutes);
  app.use('/auth', authRoutes); // keep original mount too
}
if (employeesRoutes) {
  app.use('/api/employees', employeesRoutes);
  app.use('/employees', employeesRoutes);
}
if (jobsRoutes) {
  app.use('/api/jobs', jobsRoutes);
  app.use('/jobs', jobsRoutes);
}
if (materialsRoutes) {
  app.use('/api/materials', materialsRoutes);
  app.use('/materials', materialsRoutes);
}
if (paymentsRoutes) {
  app.use('/api/payments', paymentsRoutes);
  app.use('/payments', paymentsRoutes);
}
if (attendanceRoutes) {
  app.use('/api/attendance', attendanceRoutes);
  app.use('/attendance', attendanceRoutes);
}
if (activitiesRoutes) {
  app.use('/api/activities', activitiesRoutes);
  app.use('/activities', activitiesRoutes);
}
if (analyticsRoutes) {
  app.use('/api/analytics', analyticsRoutes);
  app.use('/analytics', analyticsRoutes);
}

// Friendly root so visiting the base URL shows a message
app.get('/', (req, res) => {
  res.send('SmartERP Backend API is running. Use /api/auth or /auth endpoints.');
});

// Healthcheck
app.get('/health', (req, res) => res.json({ ok: true }));

// Start server after DB setup
(async () => {
  try {
    // ensureAll will run schema checks safely (it uses the pool)
    if (typeof ensureAll === 'function') {
      await ensureAll();
    } else {
      console.warn('No ensureAll() exported from dbSetup, skipping schema checks.');
    }

    const PORT = process.env.PORT || 4000;
    app.listen(PORT, () => {
      console.log(`🚀 SmartERP backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Startup error:', err);
    const PORT = process.env.PORT || 4000;
    app.listen(PORT, () => {
      console.log(`🚀 SmartERP backend running (startup errors) on port ${PORT}`);
    });
  }
})();
