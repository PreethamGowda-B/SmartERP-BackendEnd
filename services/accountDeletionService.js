const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { redisClient } = require('../utils/redis');
const { storage } = require('../middleware/als');

// In-memory fallback token store if Redis is temporarily offline in test environments
const localTokenStore = new Map();

/**
 * Service managing secure account deletion and privacy erasure across SmartERP
 */
class AccountDeletionService {
  /**
   * Helper to store deletion challenge token (TTL 10 minutes)
   */
  static async setChallengeToken(prefix, id, token) {
    const key = `deletion_challenge:${prefix}:${id}`;
    const ttlSeconds = 600; // 10 minutes
    if (redisClient && redisClient.status === 'ready') {
      try {
        await redisClient.set(key, token, 'EX', ttlSeconds);
        return;
      } catch (err) {
        console.warn('⚠️ Redis error setting deletion token, using local cache:', err.message);
      }
    }
    localTokenStore.set(key, { token, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  /**
   * Helper to verify and consume challenge token (one-time use)
   */
  static async consumeChallengeToken(prefix, id, token) {
    const key = `deletion_challenge:${prefix}:${id}`;
    let storedToken = null;

    if (redisClient && redisClient.status === 'ready') {
      try {
        storedToken = await redisClient.get(key);
        if (storedToken) {
          await redisClient.del(key); // Invalidate immediately (prevent replay)
        }
      } catch (err) {
        console.warn('⚠️ Redis error getting deletion token:', err.message);
      }
    }

    if (!storedToken && localTokenStore.has(key)) {
      const entry = localTokenStore.get(key);
      localTokenStore.delete(key);
      if (entry && entry.expiresAt > Date.now()) {
        storedToken = entry.token;
      }
    }

    if (!storedToken || storedToken !== token) {
      return false;
    }
    return true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STAFF / INTERNAL USERS (Owner, Employee, HR, Admin, Super Admin)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Step 1: Request Deletion Challenge for Staff User
   */
  static async requestStaffDeletion({ userId, companyId, role, password, isOAuth = false }) {
    return storage.run({ isWebRequest: true, bypassRls: true }, async () => {
      if (!userId) {
        throw { status: 401, message: 'Unauthorized: Missing user identity.' };
      }

      // 1. Fetch user record
      const userRes = await pool.query(
        `SELECT id, name, email, role, company_id, password_hash, google_id, created_at, is_deleted
         FROM users
         WHERE id::text = $1::text`,
        [userId]
      );

      if (userRes.rows.length === 0 || userRes.rows[0].is_deleted) {
        throw { status: 404, message: 'User account not found or already deleted.' };
      }

      const user = userRes.rows[0];

      // 2. Re-authentication verification
      if (user.password_hash) {
        if (!password) {
          throw { status: 400, message: 'Password confirmation is required to delete your account.' };
        }
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
          throw { status: 401, message: 'Invalid password confirmation. Account deletion rejected.' };
        }
      } else if (user.google_id && !isOAuth) {
        throw { status: 400, message: 'Please re-authenticate with Google before deleting your account.' };
      }

      // 3. Special Owner Protection Rules
      if (user.role === 'owner') {
        const userCompId = user.company_id || companyId;
        if (userCompId) {
          // Check for other active owners in the same company
          const adminCheck = await pool.query(
            `SELECT count(*) as count
             FROM users
             WHERE company_id::text = $1::text
               AND id::text != $2::text
               AND role = 'owner'
               AND (is_deleted IS NULL OR is_deleted = FALSE)
               AND (is_active IS NULL OR is_active = TRUE)`,
            [userCompId, userId]
          );
          const otherAdmins = parseInt(adminCheck.rows[0]?.count || 0, 10);

          // Check if the company has active workforce or operations
          const staffCheck = await pool.query(
            `SELECT count(*) as count
             FROM users
             WHERE company_id::text = $1::text
               AND id::text != $2::text
               AND (is_deleted IS NULL OR is_deleted = FALSE)`,
            [userCompId, userId]
          );
          const totalStaff = parseInt(staffCheck.rows[0]?.count || 0, 10);

          if (otherAdmins === 0 && totalStaff > 0) {
            throw {
              status: 403,
              message: 'Owner Deletion Blocked: You are the sole Owner of an active company. Please transfer ownership to another administrator or decommission your team before deleting your account.',
              requiresOwnershipTransfer: true
            };
          }
        }
      }

      // 4. Generate cryptographically secure one-time challenge token
      const challengeToken = crypto.randomBytes(32).toString('hex');
      await this.setChallengeToken('staff', userId, challengeToken);

      return {
        success: true,
        challengeToken,
        expiresInSeconds: 600,
        confirmationPhrase: 'DELETE MY ACCOUNT',
        warning: {
          summary: 'This action is permanent. Your personal login credentials and PII will be erased.',
          retentionNotice: 'Operational and financial records (such as completed jobs, invoices, GST filings, and attendance history) are retained under statutory compliance and business integrity policies.'
        }
      };
    });
  }

  /**
   * Step 2: Confirm Staff Deletion & Execute Transactional Erasure
   */
  static async confirmStaffDeletion({ userId, companyId, challengeToken, confirmationPhrase, ipAddress, userAgent, reason }) {
    return storage.run({ isWebRequest: true, bypassRls: true }, async () => {
      if (!userId) {
        throw { status: 401, message: 'Unauthorized: Missing user identity.' };
      }

      // 1. Validate confirmation phrase
      if (!confirmationPhrase || confirmationPhrase.trim() !== 'DELETE MY ACCOUNT') {
        throw { status: 400, message: 'Invalid confirmation phrase. You must type "DELETE MY ACCOUNT" exactly.' };
      }

      // 2. Validate and consume one-time token
      const isValidToken = await this.consumeChallengeToken('staff', userId, challengeToken);
      if (!isValidToken) {
        throw { status: 400, message: 'Invalid or expired deletion challenge token. Please request a new deletion confirmation.' };
      }

      // 3. Begin Transactional Database Deletion & Erasure
      let user = null;
      let retainedSummary = {};
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const userRes = await client.query(
          `SELECT id, name, email, role, company_id, is_deleted
           FROM users
           WHERE id::text = $1::text
           FOR UPDATE`,
          [userId]
        );

        if (userRes.rows.length === 0 || userRes.rows[0].is_deleted) {
          await client.query('ROLLBACK');
          throw { status: 404, message: 'User account not found or already deleted.' };
        }

        user = userRes.rows[0];

        // Re-verify Owner rules inside transaction
        if (user.role === 'owner' && user.company_id) {
          const adminCheck = await client.query(
            `SELECT count(*) as count
             FROM users
             WHERE company_id::text = $1::text
               AND id::text != $2::text
               AND role = 'owner'
               AND (is_deleted IS NULL OR is_deleted = FALSE)`,
            [user.company_id, userId]
          );
          const staffCheck = await client.query(
            `SELECT count(*) as count
             FROM users
             WHERE company_id::text = $1::text
               AND id::text != $2::text
               AND (is_deleted IS NULL OR is_deleted = FALSE)`,
            [user.company_id, userId]
          );
          if (parseInt(adminCheck.rows[0]?.count || 0) === 0 && parseInt(staffCheck.rows[0]?.count || 0) > 0) {
            await client.query('ROLLBACK');
            throw {
              status: 403,
              message: 'Owner Deletion Blocked: You must transfer ownership before deleting your account.'
            };
          }
        }

        // Summary of retained historical business records for audit
        const [jobsRes, invoicesRes, payrollRes] = await Promise.all([
          client.query('SELECT count(*) as count FROM jobs WHERE assigned_employee_id::text = $1::text', [userId]).catch(() => ({ rows: [{ count: 0 }] })),
          client.query('SELECT count(*) as count FROM invoices WHERE created_by::text = $1::text', [userId]).catch(() => ({ rows: [{ count: 0 }] })),
          client.query('SELECT count(*) as count FROM payroll WHERE employee_id::text = $1::text', [userId]).catch(() => ({ rows: [{ count: 0 }] }))
        ]);

        const retainedSummary = {
          jobs_associated: parseInt(jobsRes.rows[0]?.count || 0, 10),
          invoices_created: parseInt(invoicesRes.rows[0]?.count || 0, 10),
          payroll_records: parseInt(payrollRes.rows[0]?.count || 0, 10),
          retention_basis: 'Statutory compliance (GST Act Section 36 & Companies Act Section 128)'
        };

        // Generate unique anonymized email & name
        const anonymizedEmail = `deleted_user_${crypto.randomUUID().slice(0, 8)}@anonymized.invalid`;

        // 4. Anonymize user record
        await client.query(
          `UPDATE users
           SET name = 'Former User [Deleted]',
               email = $1,
               phone = NULL,
               password_hash = NULL,
               google_id = NULL,
               is_active = FALSE,
               is_deleted = TRUE,
               deleted_at = NOW(),
               deletion_reason = $2
           WHERE id::text = $3::text`,
          [anonymizedEmail, reason || 'User requested account deletion', userId]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // 5. Invalidate all database refresh tokens
      await pool.query('DELETE FROM refresh_tokens WHERE user_id::text = $1::text', [userId]).catch(() => {});

      // 6. Delete private personal notifications
      await pool.query('DELETE FROM notifications WHERE user_id::text = $1::text', [userId]).catch(() => {});

      // 7. Anonymize AI audit log entries
      await pool.query(
        `UPDATE ai_audit_logs
         SET user_name = 'Former User [Deleted]'
         WHERE user_id::text = $1::text`,
        [userId]
      ).catch(() => {});

      // 8. Reassign any active open jobs assigned to this technician
      await pool.query(
        `UPDATE jobs
         SET assigned_employee_id = NULL
         WHERE (assigned_employee_id::text = $1::text OR assigned_to::text = $1::text)
           AND status NOT IN ('completed', 'cancelled')`,
        [userId]
      ).catch(() => {});

      // 9. Record entry in immutable account deletion audit log
      await pool.query(
        `INSERT INTO account_deletion_audit
         (account_type, original_user_id, company_id, role, ip_address, user_agent, reason, retained_records_summary)
         VALUES ('staff', $1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          userId,
          user.company_id ? String(user.company_id) : null,
          user.role || 'employee',
          ipAddress || null,
          userAgent || null,
          reason || 'User self-service deletion',
          JSON.stringify(retainedSummary)
        ]
      ).catch((err) => console.warn('⚠️ Account deletion audit logging error:', err.message));

      // 10. Purge Redis session cache
      if (redisClient && redisClient.status === 'ready') {
        try {
          await redisClient.del(`user_rt:${userId}`);
          await redisClient.del(`employee_notifications:${userId}`);
          await redisClient.del(`ai_agent:${userId}`);
        } catch (e) {
          console.warn('⚠️ Redis session cleanup error:', e.message);
        }
      }

      return {
        success: true,
        message: 'Your account has been permanently deleted and personal data erased.'
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CUSTOMER PORTAL USERS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Step 1: Request Deletion Challenge for Customer
   */
  static async requestCustomerDeletion({ customerId, companyId, password, isOAuth = false }) {
    return storage.run({ isWebRequest: true, bypassRls: true }, async () => {
      if (!customerId) {
        throw { status: 401, message: 'Unauthorized: Missing customer identity.' };
      }

      const custRes = await pool.query(
        `SELECT id, name, email, company_id, password_hash, auth_provider, is_deleted
         FROM customers
         WHERE id::text = $1::text`,
        [customerId]
      );

      if (custRes.rows.length === 0 || custRes.rows[0].is_deleted) {
        throw { status: 404, message: 'Customer profile not found or already deleted.' };
      }

      const customer = custRes.rows[0];

      // Re-authentication
      if (customer.password_hash) {
        if (!password) {
          throw { status: 400, message: 'Password confirmation is required to delete your account.' };
        }
        const match = await bcrypt.compare(password, customer.password_hash);
        if (!match) {
          throw { status: 401, message: 'Invalid password confirmation.' };
        }
      } else if (customer.auth_provider === 'google' && !isOAuth) {
        throw { status: 400, message: 'Please re-authenticate with Google before deleting your account.' };
      }

      const challengeToken = crypto.randomBytes(32).toString('hex');
      await this.setChallengeToken('customer', customerId, challengeToken);

      return {
        success: true,
        challengeToken,
        expiresInSeconds: 600,
        confirmationPhrase: 'DELETE MY ACCOUNT',
        warning: {
          summary: 'Your customer portal login and profile will be permanently deleted.',
          retentionNotice: 'Machine service histories, completed job workorders, and tax invoices are retained in company archives.'
        }
      };
    });
  }

  /**
   * Step 2: Confirm Customer Deletion & Execute Transactional Erasure
   */
  static async confirmCustomerDeletion({ customerId, companyId, challengeToken, confirmationPhrase, ipAddress, userAgent, reason }) {
    return storage.run({ isWebRequest: true, bypassRls: true }, async () => {
      if (!customerId) {
        throw { status: 401, message: 'Unauthorized: Missing customer identity.' };
      }

      if (!confirmationPhrase || confirmationPhrase.trim() !== 'DELETE MY ACCOUNT') {
        throw { status: 400, message: 'Invalid confirmation phrase. You must type "DELETE MY ACCOUNT" exactly.' };
      }

      const isValidToken = await this.consumeChallengeToken('customer', customerId, challengeToken);
      if (!isValidToken) {
        throw { status: 400, message: 'Invalid or expired deletion challenge token.' };
      }

      let customer = null;
      let retainedSummary = {};
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const custRes = await client.query(
          `SELECT id, name, email, company_id, is_deleted
           FROM customers
           WHERE id::text = $1::text
           FOR UPDATE`,
          [customerId]
        );

        if (custRes.rows.length === 0 || custRes.rows[0].is_deleted) {
          await client.query('ROLLBACK');
          throw { status: 404, message: 'Customer account not found or already deleted.' };
        }

        customer = custRes.rows[0];

        // Summary of retained records
        const [machinesRes, invoicesRes] = await Promise.all([
          client.query('SELECT count(*) as count FROM customer_machines WHERE customer_id::text = $1::text', [customerId]).catch(() => ({ rows: [{ count: 0 }] })),
          client.query('SELECT count(*) as count FROM invoices WHERE customer_id::text = $1::text', [customerId]).catch(() => ({ rows: [{ count: 0 }] }))
        ]);

        const retainedSummary = {
          registered_machines: parseInt(machinesRes.rows[0]?.count || 0, 10),
          tax_invoices: parseInt(invoicesRes.rows[0]?.count || 0, 10),
          retention_basis: 'Tax invoice statutory record retention'
        };

        const anonymizedEmail = `deleted_cust_${crypto.randomUUID().slice(0, 8)}@anonymized.invalid`;

        // Anonymize customer row
        await client.query(
          `UPDATE customers
           SET name = 'Deleted Customer',
               email = $1,
               phone = NULL,
               password_hash = NULL,
               is_deleted = TRUE,
               deleted_at = NOW(),
               deletion_reason = $2
           WHERE id::text = $3::text`,
          [anonymizedEmail, reason || 'Customer requested data erasure', customerId]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Invalidate customer refresh tokens
      await pool.query('DELETE FROM customer_refresh_tokens WHERE customer_id::text = $1::text', [customerId]).catch(() => {});

      // Delete customer notifications
      await pool.query('DELETE FROM customer_notifications WHERE customer_id::text = $1::text', [customerId]).catch(() => {});

      // Record in audit log
      await pool.query(
        `INSERT INTO account_deletion_audit
         (account_type, original_user_id, company_id, role, ip_address, user_agent, reason, retained_records_summary)
         VALUES ('customer', $1, $2, 'customer', $3, $4, $5, $6::jsonb)`,
        [
          customerId,
          customer.company_id ? String(customer.company_id) : null,
          ipAddress || null,
          userAgent || null,
          reason || 'Customer self-service deletion',
          JSON.stringify(retainedSummary)
        ]
      ).catch((err) => console.warn('⚠️ Customer deletion audit log error:', err.message));

      return {
        success: true,
        message: 'Your customer portal account has been permanently deleted.'
      };
    });
  }
}

module.exports = AccountDeletionService;
