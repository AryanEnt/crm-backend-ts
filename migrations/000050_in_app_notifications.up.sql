-- Persistent in-app notifications and SLA-breach deduplication.
-- Recipients only ever see their own rows; unique (recipient, dedupe_key) stops duplicate scans.

INSERT INTO organization_settings (key, value, value_type)
VALUES
    ('notifications.sla_notify_team_lead', 'true', 'boolean'),
    ('notifications.sla_scan_minutes', '15', 'number')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE in_app_notifications (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type               TEXT NOT NULL,
    title              TEXT NOT NULL,
    body               TEXT NOT NULL,
    lead_id            UUID REFERENCES leads(id) ON DELETE SET NULL,
    payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key         TEXT NOT NULL,
    read_at            TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT in_app_notifications_recipient_dedupe UNIQUE (recipient_user_id, dedupe_key)
);

CREATE INDEX in_app_notifications_inbox_idx
    ON in_app_notifications (recipient_user_id, created_at DESC);

CREATE INDEX in_app_notifications_unread_idx
    ON in_app_notifications (recipient_user_id, created_at DESC)
    WHERE read_at IS NULL;

CREATE INDEX in_app_notifications_type_idx
    ON in_app_notifications (recipient_user_id, type, created_at DESC);
