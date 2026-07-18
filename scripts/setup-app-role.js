require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Creating role smarterp_app...');
    // Create a role that does not have BYPASSRLS
    await pool.query(`
      CREATE ROLE smarterp_app WITH LOGIN NOBYPASSRLS PASSWORD 'Secure_App_Pwd_9988#$!';
    `).catch(err => {
      if (err.code === '42710') {
        console.log('Role smarterp_app already exists, continuing...');
      } else {
        throw err;
      }
    });

    console.log('Granting permissions to smarterp_app...');
    await pool.query('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO smarterp_app');
    await pool.query('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO smarterp_app');
    await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO smarterp_app');
    await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO smarterp_app');

    console.log('Granting smarterp_app role to neondb_owner...');
    await pool.query('GRANT smarterp_app TO neondb_owner');

    console.log('✅ App role setup complete!');
  } catch (err) {
    console.error('❌ Error setting up app role:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
