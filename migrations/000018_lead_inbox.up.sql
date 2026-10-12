ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
    CHECK (status IN ('inbox', 'open', 'qualified', 'converted', 'archived', 'unqualified'));
ALTER TABLE leads ALTER COLUMN status SET DEFAULT 'inbox';
