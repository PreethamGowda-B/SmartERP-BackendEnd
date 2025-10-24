require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pool = require('./db');

const app = express();

// ✅ Import routes
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const jobsRoutes = require('./routes/jobs');
const activitiesRoutes = require('./routes/activities');
const attendanceRoutes = require('./routes/attendance');
const materialsRoutes = require('./routes/materials');
const payrollRoutes = require('./routes/payroll');
const notificationsRoutes = require('./routes/notifications');
const paymentsRoutes = require('./routes/payments');
const analyticsRoutes = require('./routes/analytics');
const employeesRoutes = require('./routes/employees');

// ✅ Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN,
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());

// ✅ API base routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/employees', employeesRoutes);

// ✅ Health check (under /api)
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'ok',
      database: 'connected',
      time: result.rows[0].now,
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      database: 'disconnected',
      message: err.message,
    });
  }
});

// ✅ Root API base (for quick check in browser)
app.get('/api', (req, res) => {
  res.json({
    message: '🚀 SmartERP Backend API is running successfully!',
    database: 'connected',
    base: '/api',
    frontend: process.env.FRONTEND_ORIGIN,
  });
});

// ✅ Root HTML (optional, for testing)
app.get('/', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.send(`
      <h1>SmartERP Backend</h1>
      <p>Status: <strong>OK</strong></p>
      <p>Database: <strong>Connected</strong></p>
      <p>API Base: <code>/api</code></p>
      <p>Server running on port ${process.env.PORT || 4000}</p>
    `);
  } catch (err) {
    console.error('DB Connection Error:', err);
    res.status(500).send(`
      <h1>SmartERP Backend</h1>
      <p>Status: <strong>ERROR</strong></p>
      <p>Database: <strong>Disconnected</strong></p>
      <p>Error: ${err.message}</p>
    `);
  }
});

// ✅ Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 SmartERP backend running on port ${PORT}`);
});
module.exports = app; // for testing purposes 