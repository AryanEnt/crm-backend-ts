-- Automation definitions, execution queue, and run audit log

CREATE TABLE automations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    trigger_type    TEXT NOT NULL,
    conditions      JSONB NOT NULL DEFAULT '[]'::jsonb,
    actions         JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX automations_trigger_active_idx ON automations (trigger_type, is_active);
CREATE INDEX automations_active_idx ON automations (is_active) WHERE is_active = TRUE;

CREATE TRIGGER automations_set_updated_at
    BEFORE UPDATE ON automations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Durable work queue (retryable). Background workers claim jobs.
CREATE TABLE automation_jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id          UUID REFERENCES automation_events(id) ON DELETE SET NULL,
    automation_id     UUID REFERENCES automations(id) ON DELETE SET NULL,
    trigger_type      TEXT NOT NULL,
    resource_type     TEXT NOT NULL DEFAULT '',
    resource_id       UUID,
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
    status            TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
    attempts          INT NOT NULL DEFAULT 0,
    max_attempts      INT NOT NULL DEFAULT 5,
    next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error        TEXT NOT NULL DEFAULT '',
    locked_at         TIMESTAMPTZ,
    locked_by         TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX automation_jobs_claim_idx
    ON automation_jobs (status, next_attempt_at)
    WHERE status IN ('pending', 'failed');
CREATE INDEX automation_jobs_event_idx ON automation_jobs (event_id);
CREATE INDEX automation_jobs_automation_idx ON automation_jobs (automation_id, created_at DESC);

CREATE TRIGGER automation_jobs_set_updated_at
    BEFORE UPDATE ON automation_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-automation execution log (never silently discard failures)
CREATE TABLE automation_runs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id     UUID REFERENCES automations(id) ON DELETE SET NULL,
    automation_name   TEXT NOT NULL DEFAULT '',
    job_id            UUID REFERENCES automation_jobs(id) ON DELETE SET NULL,
    event_id          UUID REFERENCES automation_events(id) ON DELETE SET NULL,
    trigger_type      TEXT NOT NULL,
    resource_type     TEXT NOT NULL DEFAULT '',
    resource_id       UUID,
    conditions_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
    conditions_matched BOOLEAN NOT NULL DEFAULT FALSE,
    actions_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
    action_results    JSONB NOT NULL DEFAULT '[]'::jsonb,
    status            TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
    error_message     TEXT NOT NULL DEFAULT '',
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, created_at DESC);
CREATE INDEX automation_runs_status_idx ON automation_runs (status, created_at DESC);
CREATE INDEX automation_runs_resource_idx ON automation_runs (resource_type, resource_id, created_at DESC);
CREATE INDEX automation_runs_trigger_idx ON automation_runs (trigger_type, created_at DESC);

-- Expand event status to support retry lifecycle already on jobs
ALTER TABLE automation_events
    ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS claimed_by TEXT NOT NULL DEFAULT '';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('automations:view', 'automations:manage')
  AND r.code IN ('super_admin', 'sales_manager')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code = 'automations:view'
  AND r.code IN ('sales_executive')
ON CONFLICT DO NOTHING;
