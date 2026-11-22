-- File Delivered: track when the stage email document was sent so overdue aging can stop.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS file_delivered_email_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS leads_file_delivered_email_sent_at_idx
  ON leads (file_delivered_email_sent_at)
  WHERE file_delivered_email_sent_at IS NOT NULL;
