const { pool } = require('./db');

async function debugUserCompany() {
  const email = 'prozyncinnovations@gmail.com';
  try {
    console.log(`🔍 Debugging user: ${email}`);
    
    // Check user record
    const userRes = await pool.query('SELECT id, name, email, role, company_id, company_code FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      console.log('❌ User not found');
      return;
    }
    const user = userRes.rows[0];
    console.log('👤 User Record:', JSON.stringify(user, null, 2));

    // Check company record if company_id exists
    if (user.company_id) {
      const compRes = await pool.query('SELECT * FROM companies WHERE id = $1', [user.company_id]);
      if (compRes.rows.length > 0) {
        console.log('🏢 Company Record (by numeric ID):', JSON.stringify(compRes.rows[0], null, 2));
      } else {
        console.log(`⚠️ Company with numeric ID ${user.company_id} NOT FOUND in companies table`);
      }
    }

    // Check company by company_code if it exists
    if (user.company_code) {
        const compRes2 = await pool.query('SELECT * FROM companies WHERE company_id = $1', [user.company_code]);
        if (compRes2.rows.length > 0) {
            console.log('🏢 Company Record (by string code):', JSON.stringify(compRes2.rows[0], null, 2));
        } else {
            console.log(`⚠️ Company with string code ${user.company_code} NOT FOUND in companies table`);
        }
    }

  } catch (err) {
    console.error('❌ Error debugging:', err.message);
  } finally {
    process.exit();
  }
}

debugUserCompany();
