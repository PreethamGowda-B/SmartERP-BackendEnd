#!/usr/bin/env node
/**
 * 💾 SmartERP Daily Database Backup Script
 * 
 * Exports all critical tables to JSON files and compresses them.
 * Run manually: node scripts/backup.js
 * Or schedule via cron: 0 2 * * * node /app/scripts/backup.js
 * 
 * Backup is stored in /backups/YYYY-MM-DD/ directory.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 15000
});

// Tables to back up (in dependency order)
const TABLES = [
  'companies',
  'users',
  'jobs',
  'attendance',
  'payroll',
  'notifications',
  'inventory',
  'materials',
  'subscriptions',
  'user_devices'
];

const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
const backupDir = path.join(__dirname, '..', 'backups', today);

async function runBackup() {
  console.log(`\n🚀 Starting SmartERP Backup — ${today}`);
  console.log(`📁 Backup directory: ${backupDir}\n`);

  // Create backup directory
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const summary = { date: today, tables: {}, totalRows: 0, errors: [] };

  for (const table of TABLES) {
    try {
      process.stdout.write(`  📦 Backing up ${table}... `);
      
      const result = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
      const rows = result.rows;
      
      const filePath = path.join(backupDir, `${table}.json`);
      fs.writeFileSync(filePath, JSON.stringify({
        table,
        exportedAt: new Date().toISOString(),
        rowCount: rows.length,
        data: rows
      }, null, 2));
      
      summary.tables[table] = rows.length;
      summary.totalRows += rows.length;
      console.log(`✅ ${rows.length} rows`);
    } catch (err) {
      console.log(`❌ FAILED — ${err.message}`);
      summary.errors.push({ table, error: err.message });
    }
  }

  // Write summary file
  const summaryPath = path.join(backupDir, '_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // Compress the backup folder to a .tar.gz archive
  try {
    const archiveName = `smarterp-backup-${today}.tar.gz`;
    const archivePath = path.join(__dirname, '..', 'backups', archiveName);
    execSync(`tar -czf "${archivePath}" -C "${path.join(__dirname, '..', 'backups')}" "${today}"`);
    console.log(`\n🗜️  Archive created: ${archiveName}`);
    
    // Clean up the raw folder to save disk space (keep archive only)
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (compressErr) {
    console.warn(`\n⚠️  Compression skipped (tar not available): ${compressErr.message}`);
  }

  // Print summary
  console.log('\n📊 Backup Summary:');
  console.log(`   Total rows exported: ${summary.totalRows}`);
  if (summary.errors.length > 0) {
    console.log(`   ❌ Errors: ${summary.errors.length} table(s) failed`);
    summary.errors.forEach(e => console.log(`      - ${e.table}: ${e.error}`));
  } else {
    console.log(`   ✅ All ${TABLES.length} tables backed up successfully`);
  }
  console.log(`\n✅ Backup complete!\n`);

  await pool.end();
}

runBackup().catch(err => {
  console.error('\n💥 Backup script crashed:', err);
  process.exit(1);
});
