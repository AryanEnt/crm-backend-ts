-- Gmail integration: connected accounts, threads, messages, templates

CREATE TABLE email_accounts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider                TEXT NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail')),
    email_address           TEXT NOT NULL,
    display_name            TEXT NOT NULL DEFAULT '',
    avatar_url              TEXT NOT NULL DEFAULT '',
    encrypted_access_token  TEXT NOT NULL DEFAULT '',
    encrypted_refresh_token TEXT NOT NULL DEFAULT '',
    token_expiry            TIMESTAMPTZ,
    gmail_history_id        TEXT NOT NULL DEFAULT '',
    watch_expiration        TIMESTAMPTZ,
    connection_status       TEXT NOT NULL DEFAULT 'connected'
        CHECK (connection_status IN ('connected', 'syncing', 'needs_reauth', 'error', 'disconnected')),
    last_sync_at            TIMESTAMPTZ,
    last_sync_error         TEXT NOT NULL DEFAULT '',
    sending_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    receiving_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT email_accounts_user_email_unique UNIQUE (user_id, email_address)
);

CREATE INDEX email_accounts_user_id_idx ON email_accounts (user_id);
CREATE INDEX email_accounts_status_idx ON email_accounts (connection_status);
CREATE INDEX email_accounts_email_idx ON email_accounts (lower(email_address));

CREATE TRIGGER email_accounts_set_updated_at
    BEFORE UPDATE ON email_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE email_oauth_states (
    state       TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_to TEXT NOT NULL DEFAULT '',
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX email_oauth_states_expires_idx ON email_oauth_states (expires_at);

CREATE TABLE email_threads (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id            UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    owner_user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_thread_id    TEXT NOT NULL,
    lead_id               UUID REFERENCES leads(id) ON DELETE SET NULL,
    customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
    deal_id               UUID REFERENCES deals(id) ON DELETE SET NULL,
    participants          TEXT[] NOT NULL DEFAULT '{}',
    subject               TEXT NOT NULL DEFAULT '',
    last_message_at       TIMESTAMPTZ,
    last_message_preview  TEXT NOT NULL DEFAULT '',
    message_count         INT NOT NULL DEFAULT 0,
    unread_count          INT NOT NULL DEFAULT 0,
    starred               BOOLEAN NOT NULL DEFAULT FALSE,
    archived              BOOLEAN NOT NULL DEFAULT FALSE,
    match_status          TEXT NOT NULL DEFAULT 'unmatched'
        CHECK (match_status IN ('matched', 'unmatched', 'needs_association')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT email_threads_account_provider_unique UNIQUE (account_id, provider_thread_id)
);

CREATE INDEX email_threads_owner_idx ON email_threads (owner_user_id, last_message_at DESC);
CREATE INDEX email_threads_lead_idx ON email_threads (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX email_threads_customer_idx ON email_threads (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX email_threads_match_idx ON email_threads (match_status, last_message_at DESC);
CREATE INDEX email_threads_subject_idx ON email_threads USING gin (to_tsvector('english', subject || ' ' || last_message_preview));

CREATE TRIGGER email_threads_set_updated_at
    BEFORE UPDATE ON email_threads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE email_messages (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id             UUID NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
    account_id            UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    owner_user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_message_id   TEXT NOT NULL DEFAULT '',
    provider_thread_id    TEXT NOT NULL DEFAULT '',
    direction             TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    from_address          TEXT NOT NULL DEFAULT '',
    from_name             TEXT NOT NULL DEFAULT '',
    to_addresses          TEXT[] NOT NULL DEFAULT '{}',
    cc_addresses          TEXT[] NOT NULL DEFAULT '{}',
    bcc_addresses         TEXT[] NOT NULL DEFAULT '{}',
    subject               TEXT NOT NULL DEFAULT '',
    body_html             TEXT NOT NULL DEFAULT '',
    body_text             TEXT NOT NULL DEFAULT '',
    snippet               TEXT NOT NULL DEFAULT '',
    sent_at               TIMESTAMPTZ,
    received_at           TIMESTAMPTZ,
    scheduled_at          TIMESTAMPTZ,
    status                TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'sending', 'sent', 'delivered', 'failed', 'received', 'scheduled')),
    has_attachments       BOOLEAN NOT NULL DEFAULT FALSE,
    in_reply_to           UUID REFERENCES email_messages(id) ON DELETE SET NULL,
    activity_id           UUID,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX email_messages_provider_id_unique
    ON email_messages (account_id, provider_message_id)
    WHERE provider_message_id <> '';

CREATE INDEX email_messages_thread_idx ON email_messages (thread_id, created_at);
CREATE INDEX email_messages_owner_idx ON email_messages (owner_user_id, created_at DESC);
CREATE INDEX email_messages_status_idx ON email_messages (status, scheduled_at)
    WHERE status = 'scheduled';

CREATE TRIGGER email_messages_set_updated_at
    BEFORE UPDATE ON email_messages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE email_attachments (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id              UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
    filename                TEXT NOT NULL,
    mime_type               TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes              BIGINT NOT NULL DEFAULT 0,
    provider_attachment_id  TEXT NOT NULL DEFAULT '',
    storage_key             TEXT NOT NULL DEFAULT '',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX email_attachments_message_idx ON email_attachments (message_id);

CREATE TABLE email_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    subject     TEXT NOT NULL DEFAULT '',
    body_html   TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT 'general',
    variables   TEXT[] NOT NULL DEFAULT '{}',
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    team_id     UUID REFERENCES teams(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX email_templates_active_idx ON email_templates (is_active, category);
CREATE TRIGGER email_templates_set_updated_at
    BEFORE UPDATE ON email_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permissions (code, resource, action, description)
VALUES
    ('email:view', 'email', 'view', 'View CRM email threads'),
    ('email:send', 'email', 'send', 'Send email from a connected Gmail account'),
    ('email:manage', 'email', 'manage', 'Manage email templates and associations'),
    ('email:configure', 'email', 'configure', 'Configure Gmail OAuth and integration health')
ON CONFLICT (code) DO NOTHING;

-- Super Admin: configure + view (not daily send)
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'organization'
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'super_admin'
  AND p.code IN ('email:view', 'email:configure', 'email:manage')
ON CONFLICT DO NOTHING;

-- Team Lead: team-scoped CRM email visibility + templates
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'team'
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'sales_manager'
  AND p.code IN ('email:view', 'email:send', 'email:manage')
ON CONFLICT DO NOTHING;

-- SE / Support: own mailbox + send
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'own'
FROM roles r
CROSS JOIN permissions p
WHERE r.code IN ('sales_executive', 'sales_support')
  AND p.code IN ('email:view', 'email:send')
ON CONFLICT DO NOTHING;
