// back/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { pool } = require('./db');
const { ensureAll } = require('./dbSetup');

// add these lines near where you already mount routes
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeesRoutes);

// Also add for other route modules if present
// e.g. if you have jobsRoutes, materialsRoutes, paymentsRoutes, attendanceRoutes, activitiesRoutes, analyticsRoutes, etc:
const jobsRoutes = require('./routes/jobs');        // if not already required
const materialsRoutes = require('./routes/materials');
const paymentsRoutes = require('./routes/payments');
const attendanceRoutes = require('./routes/attendance');
const activitiesRoutes = require('./routes/activities');
const analyticsRoutes = require('./routes/analytics');
// mount them under /api as well
app.use('/api/jobs', jobsRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/analytics', analyticsRoutes);

// Keep the original mounts if they already exist (optional)
app.use('/auth', authRoutes);
app.use('/employees', employeesRoutes);


// healthcheck
app.get('/health', (req, res) => res.json({ ok: true }));

// start server after ensuring DB schema / setup
(async () => {
  try {
    await ensureAll();

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
