-- Admin-managed mapping from a mailbox domain to its mail provider (Migadu, Spacemail or a custom
-- IMAP/SMTP server). Used to pick server settings when a mailbox is connected; each mailbox still
-- stores its own copy of the provider and settings in email_accounts.

CREATE TABLE IF NOT EXISTS email_domain_providers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain       TEXT NOT NULL,
    provider     TEXT NOT NULL CHECK (provider IN ('migadu', 'spacemail', 'imap')),
    imap_host    TEXT NOT NULL DEFAULT '',
    imap_port    INTEGER NOT NULL DEFAULT 993 CHECK (imap_port BETWEEN 1 AND 65535),
    imap_secure  BOOLEAN NOT NULL DEFAULT TRUE,
    smtp_host    TEXT NOT NULL DEFAULT '',
    smtp_port    INTEGER NOT NULL DEFAULT 465 CHECK (smtp_port BETWEEN 1 AND 65535),
    smtp_secure  BOOLEAN NOT NULL DEFAULT TRUE,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT email_domain_providers_domain_check CHECK (domain <> '' AND domain = LOWER(domain)),
    CONSTRAINT email_domain_providers_custom_hosts_check CHECK (
        provider <> 'imap' OR (imap_host <> '' AND smtp_host <> '')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS email_domain_providers_domain_idx ON email_domain_providers (domain);
