-- Lead scoring history + prediction audit trail

CREATE TABLE lead_score_snapshots (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    score             NUMERIC(6, 2) NOT NULL,
    strategy_code     TEXT NOT NULL,
    strategy_version  TEXT NOT NULL,
    features          JSONB NOT NULL DEFAULT '{}'::jsonb,
    positive_signals  JSONB NOT NULL DEFAULT '[]'::jsonb,
    negative_signals  JSONB NOT NULL DEFAULT '[]'::jsonb,
    explanation       JSONB NOT NULL DEFAULT '{}'::jsonb,
    insufficient_hist BOOLEAN NOT NULL DEFAULT FALSE,
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    computed_by       UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX lead_score_snapshots_lead_computed_idx
    ON lead_score_snapshots (lead_id, computed_at DESC);
CREATE INDEX lead_score_snapshots_strategy_idx
    ON lead_score_snapshots (strategy_code, strategy_version);

CREATE TABLE prediction_results (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type       TEXT NOT NULL
        CHECK (entity_type IN ('lead', 'deal', 'user', 'pipeline', 'team')),
    entity_id         UUID NOT NULL,
    insight_type      TEXT NOT NULL,
    strategy_code     TEXT NOT NULL,
    strategy_version  TEXT NOT NULL,
    available         BOOLEAN NOT NULL DEFAULT TRUE,
    message           TEXT NOT NULL DEFAULT '',
    score             NUMERIC(6, 2),
    label             TEXT NOT NULL DEFAULT '',
    features          JSONB NOT NULL DEFAULT '{}'::jsonb,
    positive_signals  JSONB NOT NULL DEFAULT '[]'::jsonb,
    negative_signals  JSONB NOT NULL DEFAULT '[]'::jsonb,
    explanation       JSONB NOT NULL DEFAULT '{}'::jsonb,
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    computed_by       UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX prediction_results_entity_idx
    ON prediction_results (entity_type, entity_id, insight_type, computed_at DESC);
CREATE INDEX prediction_results_insight_idx
    ON prediction_results (insight_type, computed_at DESC);
CREATE INDEX prediction_results_strategy_idx
    ON prediction_results (strategy_code, strategy_version);

INSERT INTO permissions (code, resource, action, description)
VALUES
    ('predictions:view', 'predictions', 'view', 'View lead scores and predictive insights'),
    ('predictions:manage', 'predictions', 'manage', 'Refresh and configure prediction scoring')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('predictions:view', 'predictions:manage')
  AND r.code IN ('super_admin', 'sales_manager')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code = 'predictions:view'
  AND r.code IN ('sales_executive')
ON CONFLICT DO NOTHING;
