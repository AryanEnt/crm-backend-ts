DROP TABLE IF EXISTS lead_stage_transitions;

UPDATE pipelines SET is_default = (id = '55555555-5555-5555-5555-555555555501')
WHERE kind = 'leads' AND EXISTS (SELECT 1 FROM pipelines WHERE id = '55555555-5555-5555-5555-555555555501');

UPDATE leads SET pipeline_id = NULL, stage_id = NULL WHERE pipeline_id = '55555555-5555-5555-5555-555555555504';
DELETE FROM pipeline_stages WHERE pipeline_id = '55555555-5555-5555-5555-555555555504';
DELETE FROM pipelines WHERE id = '55555555-5555-5555-5555-555555555504';

UPDATE leads SET status = 'open' WHERE status IN ('won', 'lost');
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
    CHECK (status IN ('inbox', 'open', 'qualified', 'converted', 'archived', 'unqualified'));
ALTER TABLE leads ALTER COLUMN status SET DEFAULT 'inbox';

DROP INDEX IF EXISTS leads_status_idx;
DROP INDEX IF EXISTS leads_won_at_idx;
DROP INDEX IF EXISTS leads_lost_at_idx;
DROP INDEX IF EXISTS leads_expected_close_at_idx;

ALTER TABLE leads
    DROP COLUMN IF EXISTS stage_entered_at,
    DROP COLUMN IF EXISTS lost_reason,
    DROP COLUMN IF EXISTS lost_at,
    DROP COLUMN IF EXISTS won_at,
    DROP COLUMN IF EXISTS expected_close_at,
    DROP COLUMN IF EXISTS currency,
    DROP COLUMN IF EXISTS probability;
