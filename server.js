require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

// Import route modules
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

// PostgreSQL connection
const { pool } = require('./db');

const app = express();

// CORS setup
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN,
  credentials: true
}));

app.use(cookieParser());
app.use(express.json());

// Register API routes
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

// Root route for health check
app.get('/', async (req, res) => {
  try {
    // Test DB connection
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

// Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
