const crypto = require("crypto");
const bcrypt = require("bcrypt");

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function matchesResetOtp(candidate, storedHash, computeHmacToken) {
  const expected = Buffer.from(String(storedHash || ""));
  const actual = Buffer.from(computeHmacToken(candidate));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function issueStaffPasswordResetOtp({ pool, email, computeHmacToken, generateOtp = () => crypto.randomInt(100000, 999999).toString() }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) throw httpError(400, "Email is required.");
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      "DELETE FROM email_otps WHERE LOWER(email) = $1 AND account_type = 'staff' AND purpose = 'password_reset'",
      [normalizedEmail]
    );
    await client.query(
      "UPDATE password_reset_tokens SET used = TRUE WHERE LOWER(email) = $1 AND account_type = 'staff' AND used = FALSE",
      [normalizedEmail]
    );
    await client.query(
      `INSERT INTO email_otps (email, otp_code, account_type, purpose, expires_at)
       VALUES ($1, $2, 'staff', 'password_reset', $3)`,
      [normalizedEmail, computeHmacToken(`password_reset:${otp}${normalizedEmail}`), expiresAt]
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return otp;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Verify a password-recovery OTP, consume it once, and issue a single-use
 * reset token in one transaction. The caller supplies the keyed HMAC helper so
 * the raw OTP and reset token never need to be logged or persisted.
 */
async function verifyStaffPasswordResetOtp({ pool, email, otp, computeHmacToken, request = {} }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedOtp = String(otp || "").trim();
  if (!normalizedEmail || !normalizedOtp) {
    throw httpError(400, "Email and verification code are required.");
  }

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const otpResult = await client.query(
      `SELECT id, otp_code, attempts
         FROM email_otps
        WHERE LOWER(email) = $1
          AND account_type = 'staff'
          AND purpose = 'password_reset'
          AND used = FALSE
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [normalizedEmail]
    );

    if (!otpResult.rows.length) {
      await client.query("COMMIT");
      transactionOpen = false;
      throw httpError(400, "The verification code is incorrect or expired. Please check it or request a new code.");
    }

    const otpRecord = otpResult.rows[0];
    const submittedHash = `password_reset:${normalizedOtp}${normalizedEmail}`;
    if (!matchesResetOtp(submittedHash, otpRecord.otp_code, computeHmacToken)) {
      const attempts = Number(otpRecord.attempts || 0) + 1;
      await client.query(
        "UPDATE email_otps SET attempts = $1, used = CASE WHEN $1 >= 5 THEN TRUE ELSE used END WHERE id = $2",
        [attempts, otpRecord.id]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      throw httpError(400, "The verification code is incorrect or expired. Please check it or request a new code.");
    }

    const userResult = await client.query(
      `SELECT id, email
         FROM users
        WHERE LOWER(email) = $1
          AND role IN ('owner', 'employee', 'hr', 'super_admin')
          AND is_active IS DISTINCT FROM FALSE
        LIMIT 1`,
      [normalizedEmail]
    );
    if (!userResult.rows.length) {
      await client.query("COMMIT");
      transactionOpen = false;
      throw httpError(400, "The verification code is incorrect or expired. Please request a new code.");
    }

    const user = userResult.rows[0];
    const rawResetToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = computeHmacToken(rawResetToken);
    const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await client.query("UPDATE email_otps SET used = TRUE WHERE id = $1", [otpRecord.id]);
    await client.query(
      `UPDATE password_reset_tokens
          SET used = TRUE
        WHERE account_type = 'staff' AND user_id = $1 AND used = FALSE`,
      [user.id]
    );
    await client.query(
      `INSERT INTO password_reset_tokens
         (account_type, user_id, email, token_hash, expires_at, ip_address, user_agent)
       VALUES ('staff', $1, $2, $3, $4, $5, $6)`,
      [user.id, normalizedEmail, tokenHash, tokenExpiresAt, request.ip || null, request.userAgent || null]
    );

    await client.query("COMMIT");
    transactionOpen = false;
    return { resetToken: rawResetToken, email: user.email, userId: user.id };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function validateResetPassword(password) {
  if (password.length < 8) throw httpError(400, "Password must be at least 8 characters long.");
  if (!/[A-Z]/.test(password)) throw httpError(400, "Password must contain at least one uppercase letter.");
  if (!/[a-z]/.test(password)) throw httpError(400, "Password must contain at least one lowercase letter.");
  if (!/[0-9]/.test(password)) throw httpError(400, "Password must contain at least one number.");
  if (!/[^A-Za-z0-9]/.test(password)) throw httpError(400, "Password must contain at least one special character.");
}

/**
 * Update the authoritative SmartERP staff credential only after a valid
 * single-use reset token is locked and verified. Password, token consumption,
 * and refresh-session revocation commit or roll back together.
 */
async function resetStaffPassword({ pool, email, resetToken, newPassword, computeHmacToken, bcryptImpl = bcrypt }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const rawToken = String(resetToken || "");
  const rawPassword = String(newPassword || "");
  if (!rawToken) throw httpError(400, "Reset authorization token is missing or expired. Please verify your email again.");
  validateResetPassword(rawPassword);

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    let sql = `SELECT id, user_id, email
                 FROM password_reset_tokens
                WHERE token_hash = $1
                  AND account_type = 'staff'
                  AND used = FALSE
                  AND expires_at > NOW()`;
    const params = [computeHmacToken(rawToken)];
    if (normalizedEmail) {
      sql += " AND LOWER(email) = $2";
      params.push(normalizedEmail);
    }
    sql += " ORDER BY created_at DESC LIMIT 1 FOR UPDATE";

    const tokenResult = await client.query(sql, params);
    if (!tokenResult.rows.length) {
      throw httpError(400, "The reset session is invalid or expired. Please request a new verification code.");
    }

    const tokenRecord = tokenResult.rows[0];
    const newHash = await bcryptImpl.hash(rawPassword, 10);
    const userResult = await client.query(
      `UPDATE users
          SET password_hash = $1, password_set = TRUE
        WHERE id = $2
          AND role IN ('owner', 'employee', 'hr', 'super_admin')
          AND is_active IS DISTINCT FROM FALSE
        RETURNING id`,
      [newHash, tokenRecord.user_id]
    );
    if (!userResult.rows.length) {
      throw httpError(400, "The account is unavailable for password recovery.");
    }

    await client.query(
      "UPDATE password_reset_tokens SET used = TRUE WHERE id = $1 AND used = FALSE",
      [tokenRecord.id]
    );
    await client.query("DELETE FROM refresh_tokens WHERE user_id = $1", [tokenRecord.user_id]);
    await client.query("COMMIT");
    transactionOpen = false;
    return { userId: tokenRecord.user_id, email: tokenRecord.email };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  issueStaffPasswordResetOtp,
  verifyStaffPasswordResetOtp,
  resetStaffPassword,
  validateResetPassword,
};
