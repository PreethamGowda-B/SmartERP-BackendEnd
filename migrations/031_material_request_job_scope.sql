-- Nullable job association for precise job invoice preparation. Existing
-- company material requests stay unchanged and are not attached to old jobs.
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS job_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'material_requests_job_id_fkey'
  ) THEN
    ALTER TABLE material_requests ADD CONSTRAINT material_requests_job_id_fkey
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_material_requests_company_job
  ON material_requests(company_id, job_id);
