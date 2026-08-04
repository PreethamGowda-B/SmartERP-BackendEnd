-- Master Enterprise HR Backbone Schema Migration
-- Strictly multi-tenant (company_id) with immutable audit trail

CREATE TABLE IF NOT EXISTS hr_audit_logs (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    performed_by TEXT NOT NULL,
    performed_by_name TEXT,
    action TEXT NOT NULL,
    target_employee_id TEXT,
    target_employee_name TEXT,
    old_value JSONB,
    new_value JSONB,
    reason TEXT,
    ip_address TEXT,
    device_info TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_employee_requests (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    user_id TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    request_type TEXT NOT NULL, -- 'leave', 'attendance_correction', 'salary_advance', 'shift_change', 'transfer', 'asset', 'resignation'
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'cancelled'
    details JSONB NOT NULL,
    hr_comments TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_recruitment_candidates (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    designation TEXT NOT NULL,
    department TEXT,
    stage TEXT DEFAULT 'sourced', -- 'sourced', 'interviewing', 'offered', 'joined', 'rejected'
    resume_url TEXT,
    interview_rating NUMERIC(3, 1),
    offer_letter_url TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_skills_certifications (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    user_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    certification_name TEXT,
    issuing_authority TEXT,
    expiry_date DATE,
    verified_by_hr BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_roster_shifts (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    user_id TEXT NOT NULL,
    shift_type TEXT NOT NULL, -- 'morning', 'evening', 'night', 'flexible', 'field', 'remote'
    start_time TIME,
    end_time TIME,
    effective_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_leave_balances (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    user_id TEXT NOT NULL UNIQUE,
    casual_leave_balance INT DEFAULT 12,
    sick_leave_balance INT DEFAULT 12,
    earned_leave_balance INT DEFAULT 15,
    lop_days INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_performance_reviews (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    user_id TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    period TEXT NOT NULL, -- 'Q1-2026', 'Annual-2026'
    kpi_score NUMERIC(5, 2) DEFAULT 0.0,
    rating NUMERIC(3, 1) DEFAULT 0.0, -- 1.0 to 5.0
    review_notes TEXT,
    pip_status BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_assets (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    asset_name TEXT NOT NULL,
    asset_tag TEXT NOT NULL,
    category TEXT NOT NULL, -- 'laptop', 'phone', 'vehicle', 'uniform', 'safety_gear', 'sim_card'
    assigned_to TEXT, -- user_id
    assigned_at TIMESTAMP,
    return_status TEXT DEFAULT 'assigned', -- 'assigned', 'returned', 'damaged', 'lost'
    condition TEXT DEFAULT 'good',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_safety_incidents (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    user_id TEXT NOT NULL,
    incident_type TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT DEFAULT 'low', -- 'low', 'medium', 'high', 'critical'
    status TEXT DEFAULT 'open',
    reported_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_exit_management (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    user_id TEXT NOT NULL,
    resignation_date DATE NOT NULL,
    notice_period_days INT DEFAULT 30,
    last_working_day DATE,
    kt_completed BOOLEAN DEFAULT FALSE,
    asset_returned BOOLEAN DEFAULT FALSE,
    fnf_amount NUMERIC(12, 2) DEFAULT 0.0,
    relieving_letter_url TEXT,
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'cleared', 'archived'
    created_at TIMESTAMP DEFAULT NOW()
);
