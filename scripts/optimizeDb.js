const { pool } = require('../db');

async function optimizeDatabase() {
  console.log('🚀 Starting performance optimization...');

  try {
    // 1. Core Indexes for filtering and scaling
    const queries = [
      // Users & Companies
      'CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id)',
      
      // Jobs (Most queried table)
      'CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id)',
      'CREATE INDEX IF NOT EXISTS idx_jobs_assigned_to ON jobs(assigned_to)',
      'CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)',
      'CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC)',
      
      // Attendance (Growth table)
      'CREATE INDEX IF NOT EXISTS idx_attendance_user_id ON attendance(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_attendance_clock_in ON attendance(clock_in)',
      'CREATE INDEX IF NOT EXISTS idx_attendance_comp_date ON attendance(company_id, date)',
      
      // Composite indexes for sub-second tenant dashboard and operations queries
      'CREATE INDEX IF NOT EXISTS idx_jobs_comp_status ON jobs(company_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_jobs_comp_created ON jobs(company_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_inventory_comp_deleted ON inventory_items(company_id, is_deleted)',
      'CREATE INDEX IF NOT EXISTS idx_users_comp_role ON users(company_id, role)',
      'CREATE INDEX IF NOT EXISTS idx_hr_requests_comp_status ON hr_employee_requests(company_id, status)',
      
      // Notifications (High volume)
      'CREATE INDEX IF NOT EXISTS idx_notifications_user_id_read ON notifications(user_id, read)',
      
      // Material Requests
      'CREATE INDEX IF NOT EXISTS idx_materials_company_id ON material_requests(company_id)',
      'CREATE INDEX IF NOT EXISTS idx_materials_requested_by ON material_requests(requested_by)'
    ];

    for (const q of queries) {
      try {
        await pool.query(q);
      } catch (e) {
        console.warn(`  ⚠️  Index skip: ${e.message}`);
      }
    }

    console.log('✅ Performance indexes verified/created');
  } catch (err) {
    console.error('❌ database performance optimization error:', err.message);
  }
}

module.exports = { optimizeDatabase };
