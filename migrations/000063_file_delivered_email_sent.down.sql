DROP INDEX IF EXISTS leads_file_delivered_email_sent_at_idx;

ALTER TABLE leads
  DROP COLUMN IF EXISTS file_delivered_email_sent_at;
