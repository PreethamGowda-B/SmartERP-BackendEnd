-- ============================================================================
-- Payroll Table Migration
-- Creates table for manual payroll management with email-based employee linking
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll (
  id SERIAL PRIMARY KEY,
  
  -- Employee reference (linked via email and UUID)
  employee_email VARCHAR(255) NOT NULL,
  employee_id UUID NOT NULL,
  employee_name VARCHAR(255) NOT NULL,
  
  -- Payroll period
  payroll_month INTEGER NOT NULL CHECK (payroll_month >= 1 AND payroll_month <= 12),
  payroll_year INTEGER NOT NULL CHECK (payroll_year >= 2020),
  
  -- Salary components
  base_salary DECIMAL(10,2) NOT NULL CHECK (base_salary >= 0),
  extra_amount DECIMAL(10,2) DEFAULT 0 CHECK (extra_amount >= 0),
  salary_increment DECIMAL(10,2) DEFAULT 0 CHECK (salary_increment >= 0),
  deduction DECIMAL(10,2) DEFAULT 0 CHECK (deduction >= 0),
  total_salary DECIMAL(10,2) NOT NULL CHECK (total_salary >= 0),
  
  -- Optional fields
  remarks TEXT,
  
  -- Audit fields
  created_by UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Foreign key constraints
  FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  
  -- Unique constraint: one payroll per employee per month
  UNIQUE(employee_id, payroll_month, payroll_year)
);

-- Indexes for performance
CREATE INDEX idx_payroll_employee_id ON payroll(employee_id);
CREATE INDEX idx_payroll_employee_email ON payroll(employee_email);
CREATE INDEX idx_payroll_period ON payroll(payroll_year DESC, payroll_month DESC);
CREATE INDEX idx_payroll_created_by ON payroll(created_by);

-- Comments for documentation
COMMENT ON TABLE payroll IS 'Manual payroll records created by owners for employees';
COMMENT ON COLUMN payroll.employee_email IS 'Employee email used for linking (must match users table)';
COMMENT ON COLUMN payroll.total_salary IS 'Auto-calculated: base_salary + extra_amount + salary_increment - deduction';
