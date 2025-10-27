// back/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { pool } = require('./db');
const { ensureAll } = require('./dbSetup');

const authRoutes = require('./routes/auth');
const employeesRoutes = require('./routes/employees');

const app = express();

// If behind a proxy (Render, Heroku), trust it so secure cookies work
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());

const FRONTEND = process.env.FRONTEND_ORIGIN || 'https://smart-erp-front-end.vercel.app';
app.use(cors({
  origin: FRONTEND,
  credentials: true
}));

// mount routes
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
