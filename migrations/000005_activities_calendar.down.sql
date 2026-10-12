DROP INDEX IF EXISTS activities_external_id_idx;
DROP INDEX IF EXISTS activities_status_idx;
DROP INDEX IF EXISTS activities_start_at_idx;
DROP INDEX IF EXISTS activities_type_id_idx;
DROP INDEX IF EXISTS activities_owner_user_id_idx;

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_status_check;

UPDATE activities SET status = 'planned' WHERE status IN ('upcoming', 'due', 'overdue');

ALTER TABLE activities
    DROP COLUMN IF EXISTS title,
    DROP COLUMN IF EXISTS activity_type_id,
    DROP COLUMN IF EXISTS owner_user_id,
    DROP COLUMN IF EXISTS start_at,
    DROP COLUMN IF EXISTS end_at,
    DROP COLUMN IF EXISTS priority,
    DROP COLUMN IF EXISTS outcome,
    DROP COLUMN IF EXISTS created_by_user_id,
    DROP COLUMN IF EXISTS completed_by_user_id,
    DROP COLUMN IF EXISTS external_provider,
    DROP COLUMN IF EXISTS external_id,
    DROP COLUMN IF EXISTS external_thread_id;

ALTER TABLE activities
    ADD CONSTRAINT activities_status_check
    CHECK (status IN ('planned', 'completed', 'cancelled'));

ALTER TABLE activities
    ADD CONSTRAINT activities_kind_check
    CHECK (kind IN (
        'note', 'call', 'meeting', 'task', 'email', 'whatsapp', 'sms', 'system', 'stage_change', 'assignment'
    ));

DROP TABLE IF EXISTS activity_types;

ALTER TABLE users DROP COLUMN IF EXISTS timezone;
