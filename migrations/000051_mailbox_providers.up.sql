-- Per-mailbox IMAP/SMTP settings (Migadu, Spacemail, custom) and TL manager ownership.

ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_provider_check;
ALTER TABLE email_accounts
  ADD CONSTRAINT email_accounts_provider_check CHECK (provider IN ('gmail', 'imap', 'migadu', 'spacemail'));

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS manager_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS imap_host TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS imap_port INTEGER NOT NULL DEFAULT 993,
  ADD COLUMN IF NOT EXISTS imap_secure BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS smtp_host TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS smtp_port INTEGER NOT NULL DEFAULT 465,
  ADD COLUMN IF NOT EXISTS smtp_secure BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS email_accounts_manager_idx ON email_accounts (manager_user_id)
  WHERE manager_user_id IS NOT NULL AND connection_status <> 'disconnected';
