const { pool } = require('./db');
const bcrypt = require('bcrypt');

async function repairDB() {
  const client = await pool.connect();
  try {
    console.log('🚀 Starting Database Repair...\n');

    // 1. Recreate 'plans' table
    console.log('📋 Creating "plans" table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        description TEXT,
        price_monthly NUMERIC(10, 2) DEFAULT 0,
        price_yearly NUMERIC(10, 2) DEFAULT 0,
        employee_limit INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 2. Insert default plans
    console.log('📋 Inserting default plans (Free, Basic, Pro)...');
    await client.query(`
      INSERT INTO plans (id, name, employee_limit, description)
      VALUES 
        (1, 'Free', 5, 'Free plan for small companies'),
        (2, 'Basic', 20, 'Basic plan for growing businesses'),
        (3, 'Pro', NULL, 'Pro plan with unlimited employees')
      ON CONFLICT (id) DO UPDATE SET 
        name = EXCLUDED.name, 
        employee_limit = EXCLUDED.employee_limit
    `);
    
    // Ensure the sequence is correct for the plans table
    await client.query(`SELECT setval('plans_id_seq', (SELECT MAX(id) FROM plans))`);

    // 3. Recreate 'subscriptions' table
    console.log('📋 Creating "subscriptions" table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id),
        plan_id INTEGER REFERENCES plans(id),
        start_date TIMESTAMP DEFAULT NOW(),
        end_date TIMESTAMP,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 4. Ensure 'companies' has plan_id column
    console.log('📋 Updating "companies" table schema...');
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES plans(id) DEFAULT 1`);
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'active'`);
    
    // 5. Fix remaining users' passwords (Set to 'mrpreetham123')
    console.log('📋 Resetting passwords for mrpreethu714@gmail.com and thepreethu01@gmail.com...');
    const newPasswordHash = await bcrypt.hash('mrpreetham123', 10);
    
    const emailsToReset = ['mrpreethu714@gmail.com', 'thepreethu01@gmail.com'];
    for (const email of emailsToReset) {
      const result = await client.query(
        "UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id",
        [newPasswordHash, email]
      );
      if (result.rows.length > 0) {
        console.log(`✅ Password reset for ${email}`);
      } else {
        console.log(`⚠️ User ${email} not found during password reset`);
      }
    }

    console.log('\n✅ Database repair completed successfully!');
    console.log('👉 Try signing up now, or login with your email and password: mrpreetham123');

  } catch (err) {
    console.error('\n❌ Repair failed:', err.message);
    console.error(err.stack);
  } finally {
    client.release();
    await pool.end();
  }
}

repairDB();
