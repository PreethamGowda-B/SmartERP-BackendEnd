'use strict';
const { pool } = require('../db');

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.log('No query provided');
    process.exit(0);
  }
  try {
    const res = await pool.query(query);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
