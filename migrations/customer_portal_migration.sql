 -- ===============================
-- SmartERP Customer Portal Migration
-- Safe to run multiple times — all statements use IF NOT EXISTS
-- ===============================

-- ── customers table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255),
  email           VARCHAR(255) UNIQUE NOT NULL,
  phone           VARCHAR(50),
  password_hash   VARCHAR(255),                          -- NULL for Google-only accounts
  company_id      INTEGER REFERENCES companies(id),      -- INTEGER to match companies.id (SERIAL)
  auth_provider   VARCHAR(20) DEFAULT 'manual',          -- 'manual' | 'google'
  google_id       VARCHAR(255),
  is_verified     BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ── customers indexes ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_customers_email      ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_company_id ON customers(company_id);
CREATE INDEX IF NOT EXISTS idx_customers_google_id  ON customers(google_id);

-- ── jobs table — additive columns ─────────────────────────────────────────────
-- customer_id: links a job to the customer who created it (NULL for owner/employee jobs)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);

-- source: tracks who created the job ('owner' | 'customer')
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'owner';

-- accepted_by: UUID of the employee who accepted the job
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_by UUID;

-- accepted_at already exists in schema.sql — skipped via IF NOT EXISTS
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP;

-- ── jobs indexes ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_customer_id ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_source      ON jobs(source);

-- ── refresh_tokens — add customer_id column (kept for backward compat) ────────
-- Customers are NOT in the users table, so user_id stays NULL for customer tokens.
-- customer_id stores the customers.id for customer refresh tokens.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_customer_id ON refresh_tokens(customer_id);

-- ── customer_refresh_tokens — dedicated table for customer refresh tokens ──────
-- Separate from refresh_tokens to avoid the user_id FK constraint entirely.
-- This is the canonical store for customer refresh tokens going forward.
CREATE TABLE IF NOT EXISTS customer_refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE,
  token_family    UUID NOT NULL DEFAULT gen_random_uuid(),
  revoked         BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at      TIMESTAMP NOT NULL,
  user_agent      TEXT,
  ip_address      TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crt_customer_id   ON customer_refresh_tokens(customer_id);
CREATE INDEX IF NOT EXISTS idx_crt_token         ON customer_refresh_tokens(token);
CREATE INDEX IF NOT EXISTS idx_crt_token_family  ON customer_refresh_tokens(token_family);
CREATE INDEX IF NOT EXISTS idx_crt_expires_at    ON customer_refresh_tokens(expires_at);
