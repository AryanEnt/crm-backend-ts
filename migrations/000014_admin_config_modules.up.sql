-- Custom fields, lead sources, org settings, system activity; activity type behavior flags

-- Activity type form behavior
ALTER TABLE activity_types
    ADD COLUMN IF NOT EXISTS requires_datetime BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS requires_duration BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS requires_outcome BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS requires_notes BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE activity_types SET requires_datetime = TRUE, requires_duration = TRUE
WHERE code IN ('meeting', 'consultation');
UPDATE activity_types SET requires_datetime = TRUE
WHERE code IN ('call', 'follow_up', 'reminder');
UPDATE activity_types SET requires_outcome = TRUE
WHERE code IN ('call', 'whatsapp');

-- Lead sources catalog (leads.source / customers.source remain free text for history)
CREATE TABLE lead_sources (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL UNIQUE,
    description   TEXT NOT NULL DEFAULT '',
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    position      INT NOT NULL DEFAULT 0,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER lead_sources_set_updated_at
    BEFORE UPDATE ON lead_sources
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO lead_sources (code, name, description, position) VALUES
    ('website', 'Website', 'Inbound from website forms', 1),
    ('facebook', 'Facebook', 'Facebook ads or messages', 2),
    ('instagram', 'Instagram', 'Instagram inquiries', 3),
    ('google', 'Google', 'Google ads or search', 4),
    ('whatsapp', 'WhatsApp', 'WhatsApp inquiries', 5),
    ('walk_in', 'Walk-in', 'In-person walk-in', 6),
    ('partner', 'Partner', 'Partner channel', 7),
    ('agent', 'Agent', 'Agent channel', 8),
    ('referral', 'Referral', 'Customer or partner referral', 9),
    ('cold_call', 'Cold call', 'Outbound cold call', 10),
    ('event', 'Event', 'Event or expo', 11),
    ('social', 'Social', 'Other social channels', 12),
    ('other', 'Other', 'Uncategorized source', 99)
ON CONFLICT (code) DO NOTHING;

-- Custom field definitions
CREATE TABLE custom_fields (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity        TEXT NOT NULL CHECK (entity IN ('lead', 'customer', 'deal', 'activity')),
    name          TEXT NOT NULL,
    internal_key  TEXT NOT NULL,
    field_type    TEXT NOT NULL CHECK (field_type IN (
        'text', 'long_text', 'number', 'currency', 'date', 'datetime',
        'boolean', 'single_select', 'multi_select', 'url', 'email', 'phone'
    )),
    description   TEXT NOT NULL DEFAULT '',
    help_text     TEXT NOT NULL DEFAULT '',
    is_required   BOOLEAN NOT NULL DEFAULT FALSE,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INT NOT NULL DEFAULT 0,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (entity, internal_key)
);

CREATE INDEX idx_custom_fields_entity ON custom_fields (entity, is_active, display_order);

CREATE TRIGGER custom_fields_set_updated_at
    BEFORE UPDATE ON custom_fields
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE custom_field_options (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    custom_field_id UUID NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
    label           TEXT NOT NULL,
    value           TEXT NOT NULL,
    position        INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (custom_field_id, value)
);

CREATE INDEX idx_custom_field_options_field ON custom_field_options (custom_field_id, position);

CREATE TABLE custom_field_values (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    custom_field_id UUID NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
    entity          TEXT NOT NULL CHECK (entity IN ('lead', 'customer', 'deal', 'activity')),
    record_id       UUID NOT NULL,
    value_text      TEXT,
    value_json      JSONB,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (custom_field_id, record_id)
);

CREATE INDEX idx_custom_field_values_record ON custom_field_values (entity, record_id);

CREATE TRIGGER custom_field_values_set_updated_at
    BEFORE UPDATE ON custom_field_values
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Organization settings (typed key/value)
CREATE TABLE organization_settings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key         TEXT NOT NULL UNIQUE,
    value       TEXT NOT NULL DEFAULT '',
    value_type  TEXT NOT NULL DEFAULT 'string'
        CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
    updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER organization_settings_set_updated_at
    BEFORE UPDATE ON organization_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO organization_settings (key, value, value_type) VALUES
    ('organization.name', 'Aurora CRM', 'string'),
    ('organization.email', '', 'string'),
    ('organization.phone', '', 'string'),
    ('organization.address', '', 'string'),
    ('organization.timezone', 'Australia/Sydney', 'string'),
    ('organization.currency', 'AUD', 'string'),
    ('organization.date_format', 'DD MMM YYYY', 'string'),
    ('organization.time_format', '24h', 'string'),
    ('crm.default_pipeline_id', '', 'string'),
    ('crm.default_lead_source', 'Website', 'string'),
    ('crm.default_activity_type', 'follow_up', 'string'),
    ('crm.default_lead_priority', 'medium', 'string'),
    ('crm.default_deal_currency', 'AUD', 'string'),
    ('crm.default_followup_hours', '24', 'number'),
    ('crm.default_activity_duration_minutes', '30', 'number'),
    ('notifications.email_enabled', 'true', 'boolean'),
    ('notifications.activity_reminders', 'true', 'boolean'),
    ('notifications.overdue_alerts', 'true', 'boolean'),
    ('notifications.automation', 'true', 'boolean'),
    ('security.session_hours', '12', 'number')
ON CONFLICT (key) DO NOTHING;

-- Operational system activity (separate from audit_logs)
CREATE TABLE system_activity_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type    TEXT NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    team_id       UUID REFERENCES teams(id) ON DELETE SET NULL,
    entity_type   TEXT NOT NULL DEFAULT '',
    entity_id     UUID,
    entity_label  TEXT NOT NULL DEFAULT '',
    result        TEXT NOT NULL DEFAULT 'success'
        CHECK (result IN ('success', 'failure')),
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_system_activity_created ON system_activity_events (created_at DESC);
CREATE INDEX idx_system_activity_type ON system_activity_events (event_type);
CREATE INDEX idx_system_activity_actor ON system_activity_events (actor_user_id);
CREATE INDEX idx_system_activity_entity ON system_activity_events (entity_type, entity_id);
