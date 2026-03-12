const { pool } = require('./db');

async function fixCompanyId() {
  const email = 'prozyncinnovations@gmail.com';
  // I will assign a new, professional-looking ID based on the company name "Pro Zync" and the current numeric ID 24.
  const newCompanyId = 'PRZ-1024'; 

  try {
    console.log(`🚀 Starting fix for user: ${email}`);

    // 1. Find the user and their company
    const userRes = await pool.query('SELECT company_id FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      console.error('❌ User not found');
      return;
    }

    const numericCompanyId = userRes.rows[0].company_id;
    if (!numericCompanyId) {
      console.error('❌ User has no company_id (numeric)');
      return;
    }

    console.log(`📦 Numeric Company ID (primary key): ${numericCompanyId}`);

    // 2. Update the companies table
    const updateCompRes = await pool.query(
      'UPDATE companies SET company_id = $1 WHERE id = $2 RETURNING *',
      [newCompanyId, numericCompanyId]
    );

    if (updateCompRes.rows.length === 0) {
      console.error('❌ Failed to update companies table');
      return;
    }
    console.log(`✅ Updated companies table. New short code: ${newCompanyId}`);

    // 3. Update the users table (sync company_code for all users in this company)
    const updateUserRes = await pool.query(
      'UPDATE users SET company_code = $1 WHERE company_id = $2 RETURNING id, email',
      [newCompanyId, numericCompanyId]
    );

    console.log(`✅ Updated ${updateUserRes.rowCount} users with new company_code.`);
    
    // 4. Update any other tables that might store the company string code
    // Checking material_requests
    await pool.query('UPDATE material_requests SET company_id = $1 WHERE company_id = $2', [newCompanyId, 'SMR1023']);
    // Checking jobs
    await pool.query('UPDATE jobs SET company_id = $1 WHERE company_id = $2', [newCompanyId, 'SMR1023']);
    // Checking inventory_items
    await pool.query('UPDATE inventory_items SET company_id = $1 WHERE company_id = $2', [newCompanyId, 'SMR1023']);

    console.log('✨ All related records updated to use the new ID.');

  } catch (err) {
    console.error('❌ Error during fix:', err.message);
  } finally {
    process.exit();
  }
}

fixCompanyId();
