const { pool } = require('./db');

async function backfillCompanyIds() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Find owners with null company_id
        const res = await client.query(`
      SELECT id, email FROM users 
      WHERE role = 'owner' AND company_id IS NULL
    `);

        console.log(`Found ${res.rows.length} owners without company_id.`);

        for (const user of res.rows) {
            let unique = false;
            let companyId;

            while (!unique) {
                companyId = Math.floor(100000 + Math.random() * 900000);
                const check = await client.query('SELECT 1 FROM companies WHERE id = $1', [companyId]);
                if (check.rows.length === 0) {
                    unique = true;
                }
            }

            // Create company record first
            const companyName = `${user.email.split('@')[0]}'s Company`;
            await client.query(
                `INSERT INTO companies (id, name, owner_email, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, true, NOW(), NOW())`,
                [companyId, companyName, user.email]
            );

            // Link user to company
            await client.query('UPDATE users SET company_id = $1 WHERE id = $2', [companyId, user.id]);
            console.log(`Created company ${companyId} and assigned to ${user.email}`);
        }

        await client.query('COMMIT');
        console.log('Backfill complete.');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error backfilling company IDs:', err);
    } finally {
        client.release();
        pool.end(); // Close pool to exit script
    }
}

backfillCompanyIds();
