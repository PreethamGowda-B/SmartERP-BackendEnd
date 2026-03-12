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
      'CREATE INDEX IF NOT EXISTS idx_attendance_user_id ON attendance_records(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_attendance_clock_in ON attendance_records(clock_in)',
      
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
