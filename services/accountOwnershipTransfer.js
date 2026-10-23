'use strict';

function transferError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function transferOwnership({ pool, storage, bcrypt, currentUserId, companyId, newOwnerId, password }) {
  if (!currentUserId || !companyId) throw transferError(401, 'Authenticated user and company context are required.');
  if (!newOwnerId || !password) throw transferError(400, 'new_owner_id and password confirmation are required.');
  if (String(newOwnerId) === String(currentUserId)) throw transferError(400, 'Cannot transfer ownership to yourself.');

  // Only this authenticated owner-transfer operation receives the database
  // bypass; ordinary account routes keep the request's tenant-scoped context.
  return storage.run({ isWebRequest: true, bypassRls: true }, async () => {
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;

      const owner = await client.query(
        `SELECT password_hash FROM users
          WHERE id::text=$1::text AND company_id::text=$2::text AND role='owner'
            AND (is_deleted IS NULL OR is_deleted=FALSE)
            AND (is_active IS NULL OR is_active=TRUE)
          FOR UPDATE`,
        [String(currentUserId), String(companyId)]
      );
      if (!owner.rows[0]?.password_hash) {
        throw transferError(403, 'The authenticated account is no longer an active owner of this company.');
      }
      if (!await bcrypt.compare(password, owner.rows[0].password_hash)) {
        throw transferError(401, 'Incorrect password confirmation.');
      }

      const target = await client.query(
        `SELECT id FROM users
          WHERE id::text=$1::text AND company_id::text=$2::text
            AND (is_deleted IS NULL OR is_deleted=FALSE)
            AND (is_active IS NULL OR is_active=TRUE)
          FOR UPDATE`,
        [String(newOwnerId), String(companyId)]
      );
      if (!target.rows[0]) throw transferError(404, 'Designated user not found in your company organization.');

      const promoted = await client.query(
        `UPDATE users SET role='owner'
          WHERE id::text=$1::text AND company_id::text=$2::text
            AND (is_deleted IS NULL OR is_deleted=FALSE)
            AND (is_active IS NULL OR is_active=TRUE)`,
        [String(newOwnerId), String(companyId)]
      );
      if (promoted.rowCount !== 1) throw new Error('Ownership transfer target changed during the transaction.');

      const demoted = await client.query(
        `UPDATE users SET role='employee'
          WHERE id::text=$1::text AND company_id::text=$2::text AND role='owner'`,
        [String(currentUserId), String(companyId)]
      );
      if (demoted.rowCount !== 1) throw new Error('Current owner changed during the transaction.');

      const company = await client.query(
        `UPDATE companies SET owner_id=$1
          WHERE id::text=$2::text OR company_id::text=$2::text`,
        [String(newOwnerId), String(companyId)]
      );
      // Both legacy owner_id layouts are supported, but a transfer must only
      // touch exactly one company row. Ambiguous identity matches roll back.
      if (company.rowCount !== 1) throw new Error('Company ownership record was missing or ambiguous.');

      await client.query('COMMIT');
      transactionStarted = false;
      return true;
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

module.exports = { transferOwnership };
