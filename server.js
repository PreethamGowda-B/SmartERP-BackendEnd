require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pool = require('../db');

// Import routes
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

const app = express();

// ✅ CORS
const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use(
  cors({
    origin: allowedOrigin,
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json());

// ✅ API routes
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

// ✅ Health check
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ✅ Root route
app.get('/', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.send(`
      <h1>SmartERP Backend</h1>
      <p>Status: <strong>OK</strong></p>
      <p>Database: <strong>Connected</strong></p>
      <p>API Base: /api</p>
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
