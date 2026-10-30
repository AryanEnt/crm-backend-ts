-- Custom-domain IMAP/SMTP mailboxes alongside Gmail. Credentials stay encrypted.
-- SE owns the mailbox; a Team Lead may invite an assigned SE to connect, never store their password.

ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_provider_check;
ALTER TABLE email_accounts
  ADD CONSTRAINT email_accounts_provider_check CHECK (provider IN ('gmail', 'imap'));

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS encrypted_password TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS imap_inbox_folder TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS imap_sent_folder TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS imap_inbox_uidvalidity BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imap_inbox_uid BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imap_sent_uidvalidity BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imap_sent_uid BIGINT NOT NULL DEFAULT 0;

CREATE TABLE email_connection_invites (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash       TEXT NOT NULL UNIQUE,
    invited_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_by       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email_address    TEXT NOT NULL DEFAULT '',
    provider         TEXT NOT NULL DEFAULT 'imap' CHECK (provider IN ('gmail', 'imap')),
    expires_at       TIMESTAMPTZ NOT NULL,
    consumed_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX email_connection_invites_user_idx ON email_connection_invites (invited_user_id, expires_at DESC);
CREATE INDEX email_connection_invites_expires_idx ON email_connection_invites (expires_at);

CREATE INDEX email_accounts_provider_status_idx ON email_accounts (provider, connection_status)
  WHERE connection_status <> 'disconnected';
