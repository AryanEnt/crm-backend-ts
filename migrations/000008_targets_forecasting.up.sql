-- Targets configuration for monthly/quarterly team and individual goals

CREATE TABLE targets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL DEFAULT '',
    metric          TEXT NOT NULL
        CHECK (metric IN (
            'leads',
            'qualified_leads',
            'submissions',
            'positive_outcomes',
            'conversions',
            'pipeline_value',
            'activities'
        )),
    period_type     TEXT NOT NULL
        CHECK (period_type IN ('monthly', 'quarterly')),
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    scope_type      TEXT NOT NULL
        CHECK (scope_type IN ('organization', 'team', 'user')),
    team_id         UUID REFERENCES teams(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    pipeline_id     UUID REFERENCES pipelines(id) ON DELETE SET NULL,
    target_value    NUMERIC(18, 2) NOT NULL CHECK (target_value >= 0),
    notes           TEXT NOT NULL DEFAULT '',
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT targets_period_chk CHECK (period_end >= period_start),
    CONSTRAINT targets_scope_chk CHECK (
        (scope_type = 'organization' AND team_id IS NULL AND user_id IS NULL)
        OR (scope_type = 'team' AND team_id IS NOT NULL AND user_id IS NULL)
        OR (scope_type = 'user' AND user_id IS NOT NULL)
    )
);

CREATE INDEX targets_period_idx ON targets (period_start, period_end);
CREATE INDEX targets_metric_period_idx ON targets (metric, period_type, period_start);
CREATE INDEX targets_team_idx ON targets (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX targets_user_idx ON targets (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX targets_pipeline_idx ON targets (pipeline_id) WHERE pipeline_id IS NOT NULL;

CREATE TRIGGER targets_set_updated_at
    BEFORE UPDATE ON targets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Forecasting reads historical closed deals; index supports sample queries
CREATE INDEX IF NOT EXISTS deals_status_closed_at_idx
    ON deals (status, updated_at DESC)
    WHERE status IN ('won', 'lost');

CREATE INDEX IF NOT EXISTS deals_expected_close_idx
    ON deals (expected_close_at)
    WHERE expected_close_at IS NOT NULL AND status = 'open';
