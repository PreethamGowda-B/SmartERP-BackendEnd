-- ============================================================================
-- Migration 025: SmartERP Security AI Defensive Infrastructure
-- Tables for Security Telemetry, Correlated Incidents, and Super Admin Actions
-- ============================================================================

-- 1. Security Events (High-throughput telemetry stream)
CREATE TABLE IF NOT EXISTS security_events (
    id BIGSERIAL PRIMARY KEY,
    company_id TEXT,
    user_id TEXT,
    event_type VARCHAR(100) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'low',
    ip_address VARCHAR(50),
    user_agent TEXT,
    endpoint TEXT,
    http_method VARCHAR(10),
    status_code INTEGER,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sec_events_comp_time ON security_events(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sec_events_ip ON security_events(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sec_events_type ON security_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sec_events_created ON security_events(created_at DESC);

-- 2. Security Incidents (Correlated threat records analyzed by AI & rule engine)
CREATE TABLE IF NOT EXISTS security_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id TEXT,
    title VARCHAR(255) NOT NULL,
    threat_category VARCHAR(100) NOT NULL,
    status VARCHAR(50) DEFAULT 'open',
    severity VARCHAR(20) NOT NULL DEFAULT 'medium',
    risk_score INTEGER DEFAULT 0,
    source_ip VARCHAR(50),
    target_user_id TEXT,
    event_count INTEGER DEFAULT 1,
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ai_analysis JSONB DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sec_incidents_status ON security_incidents(status);
CREATE INDEX IF NOT EXISTS idx_sec_incidents_score ON security_incidents(risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_sec_incidents_comp ON security_incidents(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sec_incidents_created ON security_incidents(created_at DESC);

-- 3. Security Actions (Automated reversible responses and Super Admin human approvals)
CREATE TABLE IF NOT EXISTS security_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID REFERENCES security_incidents(id) ON DELETE CASCADE,
    company_id TEXT,
    action_type VARCHAR(100) NOT NULL,
    is_automated BOOLEAN DEFAULT FALSE,
    approval_status VARCHAR(50) DEFAULT 'executed',
    executed_by TEXT,
    reverted_at TIMESTAMP WITH TIME ZONE,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sec_actions_incident ON security_actions(incident_id);
CREATE INDEX IF NOT EXISTS idx_sec_actions_status ON security_actions(approval_status);
CREATE INDEX IF NOT EXISTS idx_sec_actions_created ON security_actions(created_at DESC);
