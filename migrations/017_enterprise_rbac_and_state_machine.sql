-- ==============================================================================
-- MIGRATION 017: Enterprise RBAC, Job State Machine, Multi-Technician Crew Support,
--                and Immutable Audit Trail
-- ==============================================================================

-- 1. Add Attribution & State Machine Columns to `jobs` table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assigned_employee_id UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_by UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS current_worker_id UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS state VARCHAR(50) DEFAULT 'assigned';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_override BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS override_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS override_by UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS override_at TIMESTAMPTZ;

-- Backfill attribution columns safely (only for valid users present in users table)
UPDATE jobs 
SET assigned_to = NULL
WHERE assigned_to IS NOT NULL AND assigned_to NOT IN (SELECT id FROM users);

UPDATE jobs 
SET assigned_employee_id = assigned_to,
    accepted_by = CASE WHEN employee_status = 'accepted' THEN assigned_to ELSE NULL END,
    current_worker_id = CASE WHEN employee_status = 'accepted' THEN assigned_to ELSE NULL END,
    state = CASE 
      WHEN status = 'completed' THEN 'completed'
      WHEN status = 'active' OR status = 'in_progress' THEN 'in_progress'
      WHEN employee_status = 'accepted' THEN 'accepted'
      ELSE 'assigned'
    END
WHERE state IS NULL OR state = 'assigned';

-- 2. Create Future-Ready `job_assignments` Table (Multi-Technician Crew Support)
CREATE TABLE IF NOT EXISTS job_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id VARCHAR(255) NOT NULL,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assignment_role VARCHAR(50) DEFAULT 'lead_technician',
    status VARCHAR(50) DEFAULT 'assigned',
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    hours_worked NUMERIC(10,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_assignments_job_comp ON job_assignments(job_id, company_id);
CREATE INDEX IF NOT EXISTS idx_job_assignments_emp ON job_assignments(employee_id, status);

-- 3. Create Immutable Enterprise `job_audit_logs` Table
CREATE TABLE IF NOT EXISTS job_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id VARCHAR(255) NOT NULL,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    user_role VARCHAR(50),
    action VARCHAR(100) NOT NULL,
    old_state VARCHAR(50),
    new_state VARCHAR(50),
    old_value JSONB,
    new_value JSONB,
    reason TEXT,
    metadata JSONB,
    ip_address VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_audit_logs_job ON job_audit_logs(job_id, company_id);
CREATE INDEX IF NOT EXISTS idx_job_audit_logs_action ON job_audit_logs(action, created_at);
