const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { setTenantContext } = require('../middleware/tenantContext');
const { storage } = require('../middleware/als');

describe('Employee Onboarding & Company Code Linking Flow', () => {
  test('New employee without companyId can query and link to company without RLS blocking', async () => {
    // 1. Simulate an onboarding employee context (no companyId yet)
    const mockReq = {
      user: {
        userId: 'd1e4b49b-4a5f-457f-88be-418d711022e2',
        id: 'd1e4b49b-4a5f-457f-88be-418d711022e2',
        role: 'employee',
        companyId: null
      },
      headers: {}
    };

    await new Promise((resolve, reject) => {
      setTenantContext(mockReq, {}, async () => {
        try {
          // Verify user can be looked up
          const userRes = await pool.query('SELECT id, name, email FROM users WHERE id::text = $1', [mockReq.user.id]);
          assert.strictEqual(userRes.rowCount, 1, 'Should find the onboarding user');

          // Verify company SMR1001 can be queried
          const compRes = await pool.query('SELECT id, company_id, company_name FROM companies WHERE UPPER(company_id) = $1', ['SMR1001']);
          assert.strictEqual(compRes.rowCount, 1, 'Should find company SMR1001');
          assert.strictEqual(compRes.rows[0].company_id, 'SMR1001');

          // Verify update can run in a rollback transaction
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const updateRes = await client.query(
              `UPDATE users 
               SET company_id = $1, company_code = $2 
               WHERE id::text = $3 
               RETURNING id, name, company_id, company_code`,
              [compRes.rows[0].id, compRes.rows[0].company_id, mockReq.user.id]
            );
            assert.strictEqual(updateRes.rowCount, 1, 'Should successfully link company to user row');
            assert.strictEqual(updateRes.rows[0].company_code, 'SMR1001');
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }

          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  });
});
