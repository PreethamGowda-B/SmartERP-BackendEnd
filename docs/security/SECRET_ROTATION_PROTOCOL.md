# SmartERP Production Secret Rotation Protocol

This protocol defines the standardized, zero-downtime secret rotation procedure for SmartERP production systems (Render, PostgreSQL, Redis, Razorpay).

> [!IMPORTANT]
> **Strict Guidelines**:
> - Never hardcode secrets in code, git repositories, configuration files, or logs.
> - Never log secret values (current or old) in application output, error traces, or monitoring tools.
> - Secrets must never be rotated automatically without operator supervision.
> - `_OLD` fallback secrets are **strictly temporary** and must be removed after the defined grace period.

---

## 1. Secrets Overview & Lifecycles

| Environment Variable | Role / Purpose | Rotation Cadence | Rotation Grace Window |
| :--- | :--- | :--- | :--- |
| `JWT_SECRET` | Signs & verifies short-lived user access tokens (1h) | 90 days | **24 hours** (`JWT_SECRET_OLD`) |
| `JWT_REFRESH_SECRET` | Signs & verifies long-lived refresh tokens (30d) | 90 days | **48 hours** (`JWT_REFRESH_SECRET_OLD`) |
| `RAZORPAY_WEBHOOK_SECRET`| Authenticates inbound Razorpay payment events | 180 days | **2 hours** (`RAZORPAY_WEBHOOK_SECRET_OLD`) |
| `DATABASE_URL` | PostgreSQL connection string | On compromise | Instant cutover (managed pool) |
| `REDIS_URL` | Redis cache & session store connection | On compromise | Instant cutover |
| `RESEND_API_KEY` | Transactional email provider API key | 180 days | Instant cutover |

---

## 2. Zero-Downtime Secret Rotation Procedure

SmartERP supports a **dual-secret verification window**. When a rotation begins, the system verifies signatures against the primary secret first; if that fails and an `_OLD` secret is defined, it attempts verification against the `_OLD` secret. **All newly generated tokens and signatures are signed strictly with the primary secret.**

### Phase 1: Generate New Secrets
Generate cryptographically strong secrets using OpenSSL:
```bash
# Generate 64-character (512-bit) high-entropy hex string
openssl rand -hex 64
```

### Phase 2: Promote & Configure Grace Window (Render Environment)
In your Render Dashboard (or hosting environment settings):

1. For **Access Token (`JWT_SECRET`)**:
   - Set `JWT_SECRET_OLD` = `<CURRENT_JWT_SECRET_VALUE>`
   - Set `JWT_SECRET` = `<NEW_GENERATED_SECRET_VALUE>`
2. For **Refresh Token (`JWT_REFRESH_SECRET`)**:
   - Set `JWT_REFRESH_SECRET_OLD` = `<CURRENT_JWT_REFRESH_SECRET_VALUE>`
   - Set `JWT_REFRESH_SECRET` = `<NEW_GENERATED_SECRET_VALUE>`
3. For **Razorpay Webhook (`RAZORPAY_WEBHOOK_SECRET`)**:
   - Set `RAZORPAY_WEBHOOK_SECRET_OLD` = `<CURRENT_WEBHOOK_SECRET_VALUE>`
   - In Razorpay Dashboard -> Webhooks -> Add/Edit secret to `<NEW_GENERATED_SECRET_VALUE>`
   - Set `RAZORPAY_WEBHOOK_SECRET` = `<NEW_GENERATED_SECRET_VALUE>`

Deploy the backend service.

### Phase 3: Grace Period Monitoring
- **JWT Access Tokens**: Existing user tokens expire within **1 hour**. Over the next 24 hours, users will exchange their refresh tokens to receive new access tokens signed with the new secret.
- **Razorpay Webhooks**: In-flight webhook deliveries resolve within **2 hours**.
- **No Active Users Logged Out**: Sessions are maintained transparently without interruption.

### Phase 4: Decommission `_OLD` Secrets (Removal Window)
After the grace period has elapsed:
- Access tokens: After **24 hours**
- Refresh tokens: After **48 hours**
- Razorpay webhook: After **2 hours**

Remove the `_OLD` environment variables:
1. Delete `JWT_SECRET_OLD` from Render environment settings.
2. Delete `JWT_REFRESH_SECRET_OLD` from Render environment settings.
3. Delete `RAZORPAY_WEBHOOK_SECRET_OLD` from Render environment settings.
4. Trigger a zero-downtime redeploy. Any tokens still bearing the retired key are now strictly rejected.

---

## 3. Temporary Plaintext Refresh-Token Migration Cleanup

### Background
During initial platform deployment, refresh tokens were stored as raw strings. The platform now implements SHA-256 token hashing at rest with row-level locking. To avoid logging out existing active mobile/web sessions, a temporary backward-compatibility fallback exists in `utils/tokenHash.js`.

### Removal Condition
1. Refresh tokens have a maximum lifetime of **30 days**.
2. **30 days after deployment of the hashed token system**, all legacy tokens will have either expired or been rotated into hashed tokens.
3. Once 30 days have elapsed:
   - Set environment variable:
     ```env
     DISABLE_LEGACY_PLAINTEXT_REFRESH=true
     ```
   - Verify that all active users can refresh without errors.
   - In the next minor release, remove the fallback block entirely from `utils/tokenHash.js`.

---

## 4. Emergency Key Revocation Protocol

In the event of an active secret compromise or suspected token leakage:

1. **Immediate Revocation**:
   - Change `JWT_SECRET` and `JWT_REFRESH_SECRET` immediately to new random strings.
   - Do **NOT** set `JWT_SECRET_OLD` or `JWT_REFRESH_SECRET_OLD`.
   - Invalidate all database refresh tokens:
     ```sql
     UPDATE refresh_tokens SET revoked = TRUE, updated_at = NOW();
     UPDATE customer_refresh_tokens SET revoked = TRUE;
     ```
   - Flush active Redis sessions:
     ```bash
     redis-cli FLUSHDB
     ```
2. **Impact**:
   - All active sessions are terminated immediately.
   - All users must log in again with their credentials and MFA/OTP.
   - The compromised key is instantly rendered useless.
