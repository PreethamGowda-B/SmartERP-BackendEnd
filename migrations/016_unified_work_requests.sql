-- Migration 016: Unified Work Requests & Canonical Approval Engine
CREATE TABLE IF NOT EXISTS work_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id VARCHAR(100) NOT NULL,
  
  -- Request Metadata
  request_type VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'jobs',
  urgency VARCHAR(20) DEFAULT 'normal',
  status VARCHAR(30) DEFAULT 'pending',
  
  -- Submitter Info
  submitted_by_id UUID,
  submitted_by_name VARCHAR(255),
  submitted_by_role VARCHAR(50) DEFAULT 'employee',
  
  -- Canonical Foreign Key References
  job_id UUID,
  invoice_id UUID,
  material_request_id INT,
  leave_request_id INT,
  
  -- Title, Details & Flexible Payload
  title VARCHAR(255) NOT NULL,
  reason TEXT,
  evidence_urls JSONB DEFAULT '[]'::jsonb,
  payload JSONB DEFAULT '{}'::jsonb,
  
  -- Owner Response & Resolution Audit
  owner_response TEXT,
  actioned_by_id UUID,
  actioned_by_name VARCHAR(255),
  actioned_at TIMESTAMP WITH TIME ZONE,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance Indexes for Real-Time Querying
CREATE INDEX IF NOT EXISTS idx_work_requests_company ON work_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_work_requests_status ON work_requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_work_requests_category ON work_requests(company_id, category);
CREATE INDEX IF NOT EXISTS idx_work_requests_job ON work_requests(job_id);
CREATE INDEX IF NOT EXISTS idx_work_requests_invoice ON work_requests(invoice_id);
