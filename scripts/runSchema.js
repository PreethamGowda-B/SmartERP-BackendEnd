const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
require('dotenv').config();

async function runSchema() {
  try {
    const sqlPath = path.join(__dirname, '..', 'schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('Running schema from', sqlPath);
    await pool.query(sql);
    console.log('Schema executed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Error running schema:', err.message || err);
    process.exit(1);
  }
}

runSchema();
