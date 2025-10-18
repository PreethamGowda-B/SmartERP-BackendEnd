const express = require('express');
const app = express();
const cors = require('cors');
const cookieParser = require('cookie-parser');
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
require('dotenv').config();

// Allow credentials so cookies can be sent from the frontend.
const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin, credentials: true }));
app.use(cookieParser());
app.use(express.json());

// API routes
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

// Root route
app.get('/', (req, res) => {
  const accept = req.headers.accept || '';
  if (accept.includes('application/json') || req.query.json === '1') {
    return res.json({ status: 'ok', message: 'SmartERP backend - API available under /api' });
  }

  res.send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>SmartERP Backend</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial; color:#333; padding:24px; }
          .card { max-width:800px; margin:32px auto; padding:20px; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.06); background:#fff }
          h1 { margin:0 0 8px 0 }
          p { margin:8px 0 }
          code { background:#f6f8fa; padding:4px 6px; border-radius:4px }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>SmartERP Backend</h1>
          <p>Status: <strong>OK</strong></p>
          <p>API Base: <code>/api</code></p>
          <p>Server running on port ${process.env.PORT || 4000}</p>
        </div>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
