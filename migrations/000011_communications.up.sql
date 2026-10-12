-- Multi-account communications: Meta WhatsApp + Twilio Voice (separate providers)

CREATE TABLE communication_accounts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider             TEXT NOT NULL
        CHECK (provider IN ('meta_whatsapp', 'twilio_voice')),
    name                 TEXT NOT NULL,
    display_identifier   TEXT NOT NULL DEFAULT '',  -- E.164 or WhatsApp display number
    external_account_id  TEXT NOT NULL DEFAULT '',  -- Meta phone_number_id / Twilio phone SID
    -- Server-side only. Never return this JSON to the frontend.
    credentials          JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    owner_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    team_id              UUID REFERENCES teams(id) ON DELETE SET NULL,
    allow_recordings     BOOLEAN NOT NULL DEFAULT FALSE,
    metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX communication_accounts_provider_active_idx
    ON communication_accounts (provider, is_active);
CREATE INDEX communication_accounts_owner_idx
    ON communication_accounts (owner_user_id)
    WHERE owner_user_id IS NOT NULL;
CREATE INDEX communication_accounts_team_idx
    ON communication_accounts (team_id)
    WHERE team_id IS NOT NULL;
CREATE INDEX communication_accounts_external_idx
    ON communication_accounts (provider, external_account_id);

CREATE TRIGGER communication_accounts_set_updated_at
    BEFORE UPDATE ON communication_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE whatsapp_messages (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id           UUID NOT NULL REFERENCES communication_accounts(id) ON DELETE RESTRICT,
    direction            TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    status               TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
    provider_message_id  TEXT NOT NULL DEFAULT '',
    conversation_key     TEXT NOT NULL DEFAULT '',
    from_number          TEXT NOT NULL DEFAULT '',
    to_number            TEXT NOT NULL DEFAULT '',
    body                 TEXT NOT NULL DEFAULT '',
    media_url            TEXT NOT NULL DEFAULT '',
    media_mime           TEXT NOT NULL DEFAULT '',
    media_filename       TEXT NOT NULL DEFAULT '',
    error_code           TEXT NOT NULL DEFAULT '',
    error_message        TEXT NOT NULL DEFAULT '',
    lead_id              UUID REFERENCES leads(id) ON DELETE SET NULL,
    customer_id          UUID REFERENCES customers(id) ON DELETE SET NULL,
    deal_id              UUID REFERENCES deals(id) ON DELETE SET NULL,
    activity_id          UUID REFERENCES activities(id) ON DELETE SET NULL,
    timeline_event_id    UUID REFERENCES timeline_events(id) ON DELETE SET NULL,
    actor_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    raw_payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT whatsapp_messages_entity_chk CHECK (
        lead_id IS NOT NULL OR customer_id IS NOT NULL OR deal_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX whatsapp_messages_provider_msg_uidx
    ON whatsapp_messages (account_id, provider_message_id)
    WHERE provider_message_id <> '';
CREATE INDEX whatsapp_messages_customer_idx
    ON whatsapp_messages (customer_id, occurred_at DESC)
    WHERE customer_id IS NOT NULL;
CREATE INDEX whatsapp_messages_deal_idx
    ON whatsapp_messages (deal_id, occurred_at DESC)
    WHERE deal_id IS NOT NULL;
CREATE INDEX whatsapp_messages_lead_idx
    ON whatsapp_messages (lead_id, occurred_at DESC)
    WHERE lead_id IS NOT NULL;
CREATE INDEX whatsapp_messages_conversation_idx
    ON whatsapp_messages (account_id, conversation_key, occurred_at DESC);

CREATE TRIGGER whatsapp_messages_set_updated_at
    BEFORE UPDATE ON whatsapp_messages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE twilio_calls (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id           UUID NOT NULL REFERENCES communication_accounts(id) ON DELETE RESTRICT,
    direction            TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    status               TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN (
            'queued', 'initiated', 'ringing', 'in-progress', 'completed',
            'busy', 'failed', 'no-answer', 'canceled'
        )),
    provider_call_sid    TEXT NOT NULL DEFAULT '',
    from_number          TEXT NOT NULL DEFAULT '',
    to_number            TEXT NOT NULL DEFAULT '',
    duration_seconds     INT,
    recording_sid        TEXT NOT NULL DEFAULT '',
    recording_url        TEXT NOT NULL DEFAULT '',
    error_code           TEXT NOT NULL DEFAULT '',
    error_message        TEXT NOT NULL DEFAULT '',
    lead_id              UUID REFERENCES leads(id) ON DELETE SET NULL,
    customer_id          UUID REFERENCES customers(id) ON DELETE SET NULL,
    deal_id              UUID REFERENCES deals(id) ON DELETE SET NULL,
    activity_id          UUID REFERENCES activities(id) ON DELETE SET NULL,
    timeline_event_id    UUID REFERENCES timeline_events(id) ON DELETE SET NULL,
    actor_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    raw_payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at           TIMESTAMPTZ,
    ended_at             TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT twilio_calls_entity_chk CHECK (
        lead_id IS NOT NULL OR customer_id IS NOT NULL OR deal_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX twilio_calls_provider_sid_uidx
    ON twilio_calls (account_id, provider_call_sid)
    WHERE provider_call_sid <> '';
CREATE INDEX twilio_calls_customer_idx
    ON twilio_calls (customer_id, created_at DESC)
    WHERE customer_id IS NOT NULL;
CREATE INDEX twilio_calls_deal_idx
    ON twilio_calls (deal_id, created_at DESC)
    WHERE deal_id IS NOT NULL;
CREATE INDEX twilio_calls_status_idx ON twilio_calls (status, updated_at DESC);

CREATE TRIGGER twilio_calls_set_updated_at
    BEFORE UPDATE ON twilio_calls
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Idempotent webhook processing (provider retries must not duplicate work)
CREATE TABLE webhook_receipts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider      TEXT NOT NULL,
    event_key     TEXT NOT NULL,
    http_status   INT NOT NULL DEFAULT 200,
    result        TEXT NOT NULL DEFAULT 'processed',
    error_message TEXT NOT NULL DEFAULT '',
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT webhook_receipts_provider_event_uid UNIQUE (provider, event_key)
);

CREATE INDEX webhook_receipts_created_idx ON webhook_receipts (created_at DESC);

-- Prevent duplicate timeline rows when providers retry webhooks
CREATE UNIQUE INDEX timeline_events_external_unique
    ON timeline_events (external_provider, external_id)
    WHERE external_id <> '';

INSERT INTO permissions (code, resource, action, description)
VALUES
    ('communications:view', 'communications', 'view', 'View WhatsApp and call history'),
    ('communications:send', 'communications', 'send', 'Send WhatsApp messages and place calls'),
    ('communications:manage', 'communications', 'manage', 'Manage communication accounts')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('communications:view', 'communications:send', 'communications:manage')
  AND r.code IN ('super_admin', 'sales_manager')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('communications:view', 'communications:send')
  AND r.code IN ('sales_executive')
ON CONFLICT DO NOTHING;
