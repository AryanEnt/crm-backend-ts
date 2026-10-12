-- Configurable pipelines, enriched stages, deals board support, stage history, automation hooks

ALTER TABLE pipelines
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

ALTER TABLE pipeline_stages
    ADD COLUMN IF NOT EXISTS probability NUMERIC(5,2) NOT NULL DEFAULT 0
        CHECK (probability >= 0 AND probability <= 100),
    ADD COLUMN IF NOT EXISTS visual_accent TEXT NOT NULL DEFAULT 'neutral'
        CHECK (visual_accent IN ('neutral', 'slate', 'blue', 'teal', 'green', 'amber', 'orange', 'rose', 'violet')),
    ADD COLUMN IF NOT EXISTS required_fields TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS required_activities TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS required_documents TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS sla_hours INT CHECK (sla_hours IS NULL OR sla_hours > 0),
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE deals
    ADD COLUMN IF NOT EXISTS probability NUMERIC(5,2)
        CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100)),
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS next_activity_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS field_values JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS deals_priority_idx ON deals (priority);
CREATE INDEX IF NOT EXISTS deals_last_activity_at_idx ON deals (last_activity_at);
CREATE INDEX IF NOT EXISTS deals_next_activity_at_idx ON deals (next_activity_at);
CREATE INDEX IF NOT EXISTS deals_stage_entered_at_idx ON deals (stage_entered_at);
CREATE INDEX IF NOT EXISTS deals_expected_close_at_idx ON deals (expected_close_at);

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS documents_deal_id_idx ON documents (deal_id);
CREATE INDEX IF NOT EXISTS documents_category_idx ON documents (category);

-- Historical stage transitions (powers future analytics / forecasting)
CREATE TABLE deal_stage_transitions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id           UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    from_pipeline_id  UUID REFERENCES pipelines(id) ON DELETE SET NULL,
    from_stage_id     UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
    to_pipeline_id    UUID NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
    to_stage_id       UUID NOT NULL REFERENCES pipeline_stages(id) ON DELETE RESTRICT,
    actor_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    entered_at        TIMESTAMPTZ,
    exited_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_seconds  INT,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX deal_stage_transitions_deal_id_idx ON deal_stage_transitions (deal_id, created_at DESC);
CREATE INDEX deal_stage_transitions_to_stage_idx ON deal_stage_transitions (to_stage_id, created_at DESC);
CREATE INDEX deal_stage_transitions_exited_at_idx ON deal_stage_transitions (exited_at DESC);

-- Automation event hooks (processed by future automation workers)
CREATE TABLE automation_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type     TEXT NOT NULL,
    resource_type  TEXT NOT NULL,
    resource_id    UUID,
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
    status         TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at   TIMESTAMPTZ
);

CREATE INDEX automation_events_status_idx ON automation_events (status, created_at);
CREATE INDEX automation_events_type_idx ON automation_events (event_type, created_at DESC);

-- Enrich existing seed stages with probability / accents
UPDATE pipeline_stages SET probability = 10, visual_accent = 'slate' WHERE id = '66666666-6666-6666-6666-666666666601';
UPDATE pipeline_stages SET probability = 25, visual_accent = 'blue' WHERE id = '66666666-6666-6666-6666-666666666602';
UPDATE pipeline_stages SET probability = 50, visual_accent = 'teal' WHERE id = '66666666-6666-6666-6666-666666666603';
UPDATE pipeline_stages SET probability = 0, visual_accent = 'rose', is_lost = TRUE WHERE id = '66666666-6666-6666-6666-666666666604';

UPDATE pipeline_stages SET probability = 20, visual_accent = 'blue' WHERE id = '66666666-6666-6666-6666-666666666611';
UPDATE pipeline_stages SET probability = 45, visual_accent = 'teal' WHERE id = '66666666-6666-6666-6666-666666666612';
UPDATE pipeline_stages SET probability = 70, visual_accent = 'amber' WHERE id = '66666666-6666-6666-6666-666666666613';
UPDATE pipeline_stages SET probability = 100, visual_accent = 'green', is_won = TRUE WHERE id = '66666666-6666-6666-6666-666666666614';
UPDATE pipeline_stages SET probability = 0, visual_accent = 'rose', is_lost = TRUE WHERE id = '66666666-6666-6666-6666-666666666615';

UPDATE pipelines SET description = 'Default lead qualification pipeline'
WHERE id = '55555555-5555-5555-5555-555555555501';
UPDATE pipelines SET description = 'Default sales opportunity pipeline'
WHERE id = '55555555-5555-5555-5555-555555555502';

-- Example Development Pipeline (seed only — admins can create completely different pipelines)
INSERT INTO pipelines (id, name, kind, is_default, is_active, description) VALUES
    ('55555555-5555-5555-5555-555555555503', 'Development Pipeline', 'sales', FALSE, TRUE,
     'Example multi-stage development journey. Replace or extend freely.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO pipeline_stages (
    id, pipeline_id, name, position, probability, visual_accent,
    required_fields, required_activities, required_documents, sla_hours, is_won, is_lost, is_active
) VALUES
    ('66666666-6666-6666-6666-666666666701', '55555555-5555-5555-5555-555555555503', 'Cold Lead', 1, 5, 'slate',
     '{}', '{}', '{}', 168, FALSE, FALSE, TRUE),
    ('66666666-6666-6666-6666-666666666702', '55555555-5555-5555-5555-555555555503', 'New Potential', 2, 10, 'blue',
     ARRAY['source'], '{}', '{}', 120, FALSE, FALSE, TRUE),
    ('66666666-6666-6666-6666-666666666703', '55555555-5555-5555-5555-555555555503', 'Contact Made', 3, 20, 'teal',
     ARRAY['source'], ARRAY['call'], '{}', 72, FALSE, FALSE, TRUE),
    ('66666666-6666-6666-6666-666666666704', '55555555-5555-5555-5555-555555555503', 'Qualified', 4, 35, 'violet',
     ARRAY['value','source'], ARRAY['call'], '{}', 96, FALSE, FALSE, TRUE),
    ('66666666-6666-6666-6666-666666666705', '55555555-5555-5555-5555-555555555503', 'Documents Requested', 5, 45, 'amber',
     ARRAY['value'], ARRAY['email'], '{}', 48, FALSE, FALSE, TRUE),
    ('66666666-6666-6666-6666-666666666706', '55555555-5555-5555-5555-555555555503', 'Documents Received', 6, 55, 'orange',
     ARRAY['value'], '{}', ARRAY['passport','resume'], 72, FALSE, FALSE, TRUE),
    ('66666666-6666-6666-6666-666666666707', '55555555-5555-5555-5555-555555555503', 'Application Submitted', 7, 70, 'blue',
     ARRAY['value','expectedCloseAt'], '{}', ARRAY['passport','resume'], 120, FALSE, FALSE, TRUE),
    ('66666666-6666-6666-6666-666666666708', '55555555-5555-5555-5555-555555555503', 'Waiting for Positive Outcome', 8, 85, 'amber',
     ARRAY['value','expectedCloseAt'], '{}', ARRAY['passport','resume'], 336, FALSE, FALSE, TRUE),
    ('66666666-6666-6666-6666-666666666709', '55555555-5555-5555-5555-555555555503', 'Positive Outcome', 9, 95, 'green',
     ARRAY['value'], '{}', ARRAY['passport','resume'], NULL, FALSE, FALSE, TRUE),
    ('66666666-6666-6666-6666-666666666710', '55555555-5555-5555-5555-555555555503', 'Converted', 10, 100, 'green',
     ARRAY['value'], '{}', ARRAY['passport','resume'], NULL, TRUE, FALSE, TRUE)
ON CONFLICT (id) DO NOTHING;

-- Backfill stage_entered_at for existing deals
UPDATE deals SET stage_entered_at = created_at WHERE stage_entered_at IS NULL;
