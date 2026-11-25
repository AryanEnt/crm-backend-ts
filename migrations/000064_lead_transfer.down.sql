DROP INDEX IF EXISTS leads_transferred_from_lead_id_key;

ALTER TABLE leads
  DROP COLUMN IF EXISTS transferred_from_lead_id;
