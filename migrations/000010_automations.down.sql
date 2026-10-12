DROP TRIGGER IF EXISTS automation_jobs_set_updated_at ON automation_jobs;
DROP TRIGGER IF EXISTS automations_set_updated_at ON automations;
DROP TABLE IF EXISTS automation_runs;
DROP TABLE IF EXISTS automation_jobs;
DROP TABLE IF EXISTS automations;
ALTER TABLE automation_events
    DROP COLUMN IF EXISTS attempts,
    DROP COLUMN IF EXISTS last_error,
    DROP COLUMN IF EXISTS claimed_at,
    DROP COLUMN IF EXISTS claimed_by;
