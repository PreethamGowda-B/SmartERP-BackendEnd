/**
 * dataExportService.js
 * Dynamic, tenant-isolated company data backup exporter.
 * Queries each core table with SELECT * filtered by company_id, sanitizes secrets,
 * and packages all data into formatted CSVs inside a compressed ZIP stream.
 */

const { pool } = require('../db');
const archiver = require('archiver');

class DataExportService {
  /**
   * Helper: converts an array of objects to standard CSV string
   */
  static jsonToCsv(rows) {
    if (!rows || rows.length === 0) return 'No records found\r\n';
    const headers = Object.keys(rows[0]);
    const csvRows = [];

    // Header row
    csvRows.push(headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(','));

    // Data rows
    for (const row of rows) {
      const values = headers.map(header => {
        let val = row[header];
        if (val === null || val === undefined) return '""';
        if (val instanceof Date) return `"${val.toISOString()}"`;
        if (typeof val === 'object') return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
        return `"${String(val).replace(/"/g, '""')}"`;
      });
      csvRows.push(values.join(','));
    }

    return csvRows.join('\r\n');
  }

  /**
   * Generates a complete ZIP archive stream of all company data
   */
  static async streamCompanyBackup({ companyId, res }) {
    const archive = new archiver.ZipArchive({
      zlib: { level: 9 } // Maximum compression
    });

    archive.on('error', (err) => {
      console.error('❌ Archiver stream error:', err);
    });

    archive.pipe(res);

    const safeCompanyId = String(companyId);

    // 1. Company Profile
    try {
      const comp = await pool.query(`SELECT * FROM companies WHERE id = $1`, [companyId]);
      if (comp.rows.length > 0) {
        archive.append(this.jsonToCsv(comp.rows), { name: '1_company_profile.csv' });
        archive.append(JSON.stringify(comp.rows[0], null, 2), { name: 'company_metadata.json' });
      }
    } catch (e) { console.warn('Export company warning:', e.message); }

    // 2. Users & Staff (Sanitize credentials)
    try {
      const users = await pool.query(`SELECT * FROM users WHERE company_id = $1 ORDER BY created_at DESC`, [companyId]);
      const sanitizedUsers = users.rows.map(u => {
        const copy = { ...u };
        delete copy.password_hash;
        delete copy.google_id;
        delete copy.push_token;
        return copy;
      });
      archive.append(this.jsonToCsv(sanitizedUsers), { name: '2_employees_and_staff.csv' });
    } catch (e) { console.warn('Export users warning:', e.message); }

    // 3. Jobs & Tasks
    try {
      const jobs = await pool.query(`SELECT * FROM jobs WHERE company_id = $1 ORDER BY created_at DESC`, [companyId]);
      archive.append(this.jsonToCsv(jobs.rows), { name: '3_jobs_and_tasks.csv' });
    } catch (e) { console.warn('Export jobs warning:', e.message); }

    // 4. Inventory Catalog
    try {
      const inv = await pool.query(`SELECT * FROM inventory_items WHERE company_id = $1 ORDER BY name ASC`, [companyId]);
      archive.append(this.jsonToCsv(inv.rows), { name: '4_inventory_catalog.csv' });
    } catch (e) { console.warn('Export inventory warning:', e.message); }

    // 5. Machine Registry
    try {
      const machines = await pool.query(`SELECT * FROM customer_machines WHERE company_id = $1`, [safeCompanyId]);
      archive.append(this.jsonToCsv(machines.rows), { name: '5_machine_registry.csv' });
    } catch (e) { console.warn('Export machines warning:', e.message); }

    // 6. Invoices & Billing
    try {
      const invoices = await pool.query(`SELECT * FROM invoices WHERE company_id = $1 ORDER BY created_at DESC`, [companyId]);
      archive.append(this.jsonToCsv(invoices.rows), { name: '6_invoices_and_billing.csv' });
    } catch (e) { console.warn('Export invoices warning:', e.message); }

    // 7. Attendance
    try {
      const attendance = await pool.query(`SELECT * FROM attendance WHERE company_id = $1 ORDER BY date DESC LIMIT 5000`, [companyId]);
      archive.append(this.jsonToCsv(attendance.rows), { name: '7_attendance_records.csv' });
    } catch (e) { console.warn('Export attendance warning:', e.message); }

    // 8. Payroll
    try {
      const payroll = await pool.query(`SELECT * FROM payroll WHERE company_id = $1 ORDER BY created_at DESC`, [companyId]);
      archive.append(this.jsonToCsv(payroll.rows), { name: '8_payroll_records.csv' });
    } catch (e) { console.warn('Export payroll warning:', e.message); }

    // 9. Material Requests
    try {
      const matReq = await pool.query(`SELECT * FROM material_requests WHERE company_id = $1 ORDER BY created_at DESC`, [companyId]);
      archive.append(this.jsonToCsv(matReq.rows), { name: '9_material_requests.csv' });
    } catch (e) { console.warn('Export material requests warning:', e.message); }

    // Finalize
    await archive.finalize();
  }
}

module.exports = DataExportService;
