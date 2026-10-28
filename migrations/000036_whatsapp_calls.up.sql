-- WhatsApp Cloud API Calling (Meta) — separate from Twilio Voice

CREATE TABLE whatsapp_calls (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id           UUID NOT NULL REFERENCES communication_accounts(id) ON DELETE RESTRICT,
    direction            TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    status               TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN (
            'queued', 'ringing', 'connecting', 'in-progress', 'completed',
            'failed', 'rejected', 'missed', 'canceled'
        )),
    provider_call_id     TEXT NOT NULL DEFAULT '',
    from_number          TEXT NOT NULL DEFAULT '',
    to_number            TEXT NOT NULL DEFAULT '',
    duration_seconds     INT,
    -- WebRTC signaling: remote SDP from Meta (offer for inbound, answer for outbound)
    remote_sdp           TEXT NOT NULL DEFAULT '',
    remote_sdp_type      TEXT NOT NULL DEFAULT '',
    -- Local SDP last sent to Meta (answer for inbound, offer for outbound)
    local_sdp            TEXT NOT NULL DEFAULT '',
    local_sdp_type       TEXT NOT NULL DEFAULT '',
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
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX whatsapp_calls_provider_id_uidx
    ON whatsapp_calls (account_id, provider_call_id)
    WHERE provider_call_id <> '';
CREATE INDEX whatsapp_calls_status_idx
    ON whatsapp_calls (status, updated_at DESC);
CREATE INDEX whatsapp_calls_customer_idx
    ON whatsapp_calls (customer_id, created_at DESC)
    WHERE customer_id IS NOT NULL;
CREATE INDEX whatsapp_calls_deal_idx
    ON whatsapp_calls (deal_id, created_at DESC)
    WHERE deal_id IS NOT NULL;
CREATE INDEX whatsapp_calls_lead_idx
    ON whatsapp_calls (lead_id, created_at DESC)
    WHERE lead_id IS NOT NULL;

CREATE TRIGGER whatsapp_calls_set_updated_at
    BEFORE UPDATE ON whatsapp_calls
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
