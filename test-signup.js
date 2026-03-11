const { pool } = require('./db');
const bcrypt = require('bcrypt');
const { generateCompanyId } = require('./utils/companyIdGenerator');

async function testSignup() {
  console.log('🧪 Starting Signup Flow Simulation...');
  
  const name = 'Test Owner';
  const email = `test_owner_${Date.now()}@example.com`;
  const password = 'password123';
  const role = 'owner';
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    let companyId = null;
    let companyCode = null;
    
    // 1. Generate Company ID
    companyCode = await generateCompanyId();
    const companyName = `${name}'s Company`;
    
    console.log(`📋 Inserting company: ${companyCode}`);
    const companyResult = await pool.query(
      `INSERT INTO companies (company_id, company_name, plan_id, subscription_status, created_at)
       VALUES ($1, $2, 1, 'active', NOW())
       RETURNING id, company_id`,
      [companyCode, companyName]
    );
    
    companyId = companyResult.rows[0].id;
    console.log(`✅ Company created with DB ID: ${companyId}`);
    
    // 2. Insert Subscription
    await pool.query(
      `INSERT INTO subscriptions (company_id, plan_id, start_date, status)
       VALUES ($1, 1, NOW(), 'active')`,
      [companyId]
    );
    console.log('✅ Subscription created');
    
    // 3. Insert User
    console.log(`📋 Inserting user with company_id: ${companyId}`);
    const insert = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id, company_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id`,
      [name, email, hashedPassword, role, companyId, companyCode]
    );
    
    console.log(`✅ User created with ID: ${insert.rows[0].id}`);
    
    // Clean up
    await pool.query('DELETE FROM users WHERE id = $1', [insert.rows[0].id]);
    await pool.query('DELETE FROM subscriptions WHERE company_id = $1', [companyId]);
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
    console.log('🧹 Cleanup complete');

  } catch (err) {
    console.error('❌ SIMULATION FAILED:');
    console.error('Message:', err.message);
    console.error('Detail:', err.detail);
    console.error('Hint:', err.hint);
    console.error('Code:', err.code);
    console.error('Stack:', err.stack);
  } finally {
    await pool.end();
  }
}

testSignup();
