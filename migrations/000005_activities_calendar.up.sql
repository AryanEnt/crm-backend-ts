-- Activities, tasks, follow-ups, calendar support; user timezone

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

CREATE TABLE activity_types (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code             TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    color            TEXT NOT NULL DEFAULT 'slate'
        CHECK (color IN ('slate', 'blue', 'teal', 'green', 'amber', 'orange', 'rose', 'violet', 'neutral')),
    icon             TEXT NOT NULL DEFAULT 'circle',
    is_system        BOOLEAN NOT NULL DEFAULT TRUE,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    allows_external  BOOLEAN NOT NULL DEFAULT FALSE,
    position         INT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER activity_types_set_updated_at
    BEFORE UPDATE ON activity_types
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO activity_types (code, name, description, color, icon, allows_external, position) VALUES
    ('call', 'Call', 'Phone call (Twilio-ready)', 'blue', 'phone', TRUE, 1),
    ('whatsapp', 'WhatsApp', 'WhatsApp message (integration later)', 'green', 'message', TRUE, 2),
    ('email', 'Email', 'Email correspondence', 'teal', 'mail', TRUE, 3),
    ('meeting', 'Meeting', 'Scheduled meeting', 'violet', 'calendar', FALSE, 4),
    ('follow_up', 'Follow-up', 'Follow-up task', 'amber', 'repeat', FALSE, 5),
    ('consultation', 'Consultation', 'Consultation session', 'blue', 'users', FALSE, 6),
    ('document_request', 'Document Request', 'Request for documents', 'orange', 'file', FALSE, 7),
    ('reminder', 'Reminder', 'Reminder / nudge', 'amber', 'bell', FALSE, 8),
    ('internal_task', 'Internal Task', 'Internal team task', 'slate', 'check', FALSE, 9),
    ('note', 'Note', 'Internal note', 'neutral', 'sticky', FALSE, 10),
    -- retained system kinds used by CRM automation / timeline
    ('task', 'Task', 'Generic task (legacy alias)', 'slate', 'check', FALSE, 11),
    ('sms', 'SMS', 'SMS message (Twilio-ready)', 'teal', 'message', TRUE, 12),
    ('system', 'System', 'System-generated event', 'neutral', 'cog', FALSE, 13),
    ('stage_change', 'Stage Change', 'Pipeline stage transition', 'violet', 'git', FALSE, 14),
    ('assignment', 'Assignment', 'Ownership assignment', 'slate', 'user', FALSE, 15)
ON CONFLICT (code) DO NOTHING;

-- Expand activities
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_kind_check;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_status_check;

ALTER TABLE activities
    ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS activity_type_id UUID REFERENCES activity_types(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS completed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS external_provider TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS external_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS external_thread_id TEXT NOT NULL DEFAULT '';

-- Backfill title from subject
UPDATE activities SET title = subject WHERE title = '' AND subject <> '';

-- Backfill type + created_by + owner
UPDATE activities a
SET activity_type_id = t.id
FROM activity_types t
WHERE a.activity_type_id IS NULL AND t.code = a.kind;

UPDATE activities
SET created_by_user_id = actor_user_id
WHERE created_by_user_id IS NULL AND actor_user_id IS NOT NULL;

UPDATE activities
SET owner_user_id = COALESCE(owner_user_id, actor_user_id)
WHERE owner_user_id IS NULL;

UPDATE activities
SET completed_by_user_id = actor_user_id
WHERE status = 'completed' AND completed_by_user_id IS NULL AND actor_user_id IS NOT NULL;

-- Normalize status values
UPDATE activities SET status = 'upcoming' WHERE status = 'planned';
UPDATE activities SET status = 'cancelled' WHERE status = 'cancelled';
UPDATE activities SET status = 'completed' WHERE status = 'completed';
UPDATE activities SET status = 'upcoming' WHERE status NOT IN ('upcoming', 'due', 'completed', 'overdue', 'cancelled');

ALTER TABLE activities
    ADD CONSTRAINT activities_status_check
    CHECK (status IN ('upcoming', 'due', 'completed', 'overdue', 'cancelled'));

CREATE INDEX IF NOT EXISTS activities_owner_user_id_idx ON activities (owner_user_id);
CREATE INDEX IF NOT EXISTS activities_type_id_idx ON activities (activity_type_id);
CREATE INDEX IF NOT EXISTS activities_start_at_idx ON activities (start_at);
CREATE INDEX IF NOT EXISTS activities_status_idx ON activities (status);
CREATE INDEX IF NOT EXISTS activities_external_id_idx ON activities (external_provider, external_id)
    WHERE external_id <> '';

-- Mark overdue rows that are past due
UPDATE activities
SET status = 'overdue'
WHERE status IN ('upcoming', 'due')
  AND due_at IS NOT NULL
  AND due_at < NOW();
