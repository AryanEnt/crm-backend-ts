DROP INDEX IF EXISTS email_accounts_manager_idx;

ALTER TABLE email_accounts
  DROP COLUMN IF EXISTS username,
  DROP COLUMN IF EXISTS manager_user_id,
  DROP COLUMN IF EXISTS imap_host,
  DROP COLUMN IF EXISTS imap_port,
  DROP COLUMN IF EXISTS imap_secure,
  DROP COLUMN IF EXISTS smtp_host,
  DROP COLUMN IF EXISTS smtp_port,
  DROP COLUMN IF EXISTS smtp_secure;

ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_provider_check;
ALTER TABLE email_accounts
  ADD CONSTRAINT email_accounts_provider_check CHECK (provider IN ('gmail', 'imap'));
