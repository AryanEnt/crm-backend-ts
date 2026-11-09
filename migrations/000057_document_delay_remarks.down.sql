DROP TABLE IF EXISTS lead_document_delay_remarks;

ALTER TABLE leads
  DROP COLUMN IF EXISTS document_delay_remarks_by,
  DROP COLUMN IF EXISTS document_delay_remarks_at,
  DROP COLUMN IF EXISTS document_delay_remarks;
