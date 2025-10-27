// back/dbSetup.js
const { pool } = require('./db');

async function ensureActivitiesDetailsColumn() {
  if (!pool) {
    console.error('DB pool is undefined in ensureActivitiesDetailsColumn');
    return;
  }
  try {
    await pool.query(`
      ALTER TABLE activities
      ADD COLUMN IF NOT EXISTS details TEXT;
    `);
    console.log('✅ Activities table schema verified/updated.');
  } catch (err) {
    console.error('Could not ensure activities.details column exists:', err);
  }
}

async function ensureJobsTable() {
  if (!pool) {
    console.error('DB pool is undefined in ensureJobsTable');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Jobs table schema verified/updated.');
  } catch (err) {
    console.error('Could not ensure jobs table exists:', err);
  }
}

async function ensureAll() {
  await ensureActivitiesDetailsColumn();
  await ensureJobsTable();
}

module.exports = { ensureAll, ensureActivitiesDetailsColumn, ensureJobsTable };
