// db.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: process.env.DB_PORT || 5432,
  ssl: process.env.NODE_ENV === 'production' 
       ? { rejectUnauthorized: false }  // For Render Postgres
       : false,                         // For local dev without SSL
});

// Optional: test DB connection on startup
pool.connect()
  .then(() => console.log('Postgres connected successfully'))
  .catch(err => console.error('Postgres connection error:', err));

module.exports = { pool };
