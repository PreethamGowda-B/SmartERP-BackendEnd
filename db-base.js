const { Pool } = require("pg");
require("dotenv").config();

// Standardize connection string to avoid SSL warnings
let connectionString = process.env.DATABASE_URL;
if (connectionString && connectionString.includes('sslmode=')) {
    // Remove conflicting sslmode query params if we are setting it in the config object
    connectionString = connectionString.replace(/sslmode=[^&?]+&?/, '');
}

const poolConfig = {
  connectionString: connectionString,
  ssl: { rejectUnauthorized: true },
  max: parseInt(process.env.DB_MAX_CONNECTIONS || "20"),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
};

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = { pool };
