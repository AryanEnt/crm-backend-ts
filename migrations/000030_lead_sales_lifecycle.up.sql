-- Lead-only sales lifecycle: the lead carries its own outcome, close date and stage history.
-- Additive only: customer/deal tables and the legacy lead statuses stay untouched.

ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS probability NUMERIC(5,2)
        CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100)),
    ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'AUD',
    ADD COLUMN IF NOT EXISTS expected_close_at DATE,
    ADD COLUMN IF NOT EXISTS won_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lost_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lost_reason TEXT NOT NULL DEFAULT '',
    -- NULL on rows that predate this migration; readers fall back to created_at.
    ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ;

ALTER TABLE leads ALTER COLUMN stage_entered_at SET DEFAULT NOW();

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
    CHECK (status IN ('open', 'won', 'lost', 'inbox', 'qualified', 'converted', 'archived', 'unqualified'));
ALTER TABLE leads ALTER COLUMN status SET DEFAULT 'open';

CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status);
CREATE INDEX IF NOT EXISTS leads_won_at_idx ON leads (won_at) WHERE won_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_lost_at_idx ON leads (lost_at) WHERE lost_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_expected_close_at_idx ON leads (expected_close_at);

-- One row per stage entry. entered_at is when the lead entered to_stage; duration_seconds is
-- the time it spent in from_stage.
CREATE TABLE IF NOT EXISTS lead_stage_transitions (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id                UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    from_pipeline_id       UUID REFERENCES pipelines(id) ON DELETE SET NULL,
    from_stage_id          UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
    to_pipeline_id         UUID NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
    to_stage_id            UUID NOT NULL REFERENCES pipeline_stages(id) ON DELETE RESTRICT,
    actor_user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
    from_stage_entered_at  TIMESTAMPTZ,
    entered_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_seconds       INT,
    metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lead_stage_transitions_lead_idx ON lead_stage_transitions (lead_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS lead_stage_transitions_to_stage_idx ON lead_stage_transitions (to_stage_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS lead_stage_transitions_from_stage_idx ON lead_stage_transitions (from_stage_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS lead_stage_transitions_entered_at_idx ON lead_stage_transitions (entered_at DESC);

-- Default Lead Pipeline. Fixed ids keep this idempotent; ON CONFLICT DO NOTHING also covers an
-- existing pipeline that already uses the name.
INSERT INTO pipelines (id, name, kind, is_default, is_active, description)
VALUES ('55555555-5555-5555-5555-555555555504', 'Lead Pipeline', 'leads', FALSE, TRUE,
        'Default lead sales pipeline: Created to Won or Lost.')
ON CONFLICT DO NOTHING;

INSERT INTO pipeline_stages (id, pipeline_id, name, position, probability, visual_accent, is_won, is_lost, is_active)
SELECT v.id::uuid, '55555555-5555-5555-5555-555555555504'::uuid, v.name, v.position, v.probability, v.accent,
       v.is_won, v.is_lost, TRUE
FROM (VALUES
    ('66666666-6666-6666-6666-666666666801', 'Created',     1,  10, 'slate',  FALSE, FALSE),
    ('66666666-6666-6666-6666-666666666802', 'Contacted',   2,  20, 'blue',   FALSE, FALSE),
    ('66666666-6666-6666-6666-666666666803', 'Qualified',   3,  40, 'teal',   FALSE, FALSE),
    ('66666666-6666-6666-6666-666666666804', 'Proposal',    4,  60, 'violet', FALSE, FALSE),
    ('66666666-6666-6666-6666-666666666805', 'Negotiation', 5,  80, 'amber',  FALSE, FALSE),
    ('66666666-6666-6666-6666-666666666806', 'Won',         6, 100, 'green',  TRUE,  FALSE),
    ('66666666-6666-6666-6666-666666666807', 'Lost',        7,   0, 'rose',   FALSE, TRUE)
) AS v(id, name, position, probability, accent, is_won, is_lost)
WHERE EXISTS (SELECT 1 FROM pipelines WHERE id = '55555555-5555-5555-5555-555555555504')
ON CONFLICT DO NOTHING;

-- Make it the default lead pipeline, only when it was actually created with its stages.
UPDATE pipelines
SET is_default = (id = '55555555-5555-5555-5555-555555555504')
WHERE kind = 'leads'
  AND EXISTS (
      SELECT 1 FROM pipeline_stages
      WHERE pipeline_id = '55555555-5555-5555-5555-555555555504' AND is_won
  )
  AND is_default IS DISTINCT FROM (id = '55555555-5555-5555-5555-555555555504');
