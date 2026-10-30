DROP INDEX IF EXISTS email_accounts_provider_status_idx;
DROP TABLE IF EXISTS email_connection_invites;

ALTER TABLE email_accounts
  DROP COLUMN IF EXISTS encrypted_password,
  DROP COLUMN IF EXISTS imap_inbox_folder,
  DROP COLUMN IF EXISTS imap_sent_folder,
  DROP COLUMN IF EXISTS imap_inbox_uidvalidity,
  DROP COLUMN IF EXISTS imap_inbox_uid,
  DROP COLUMN IF EXISTS imap_sent_uidvalidity,
  DROP COLUMN IF EXISTS imap_sent_uid;

ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_provider_check;
ALTER TABLE email_accounts
  ADD CONSTRAINT email_accounts_provider_check CHECK (provider IN ('gmail'));
