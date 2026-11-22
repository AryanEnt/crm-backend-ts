-- Team Lead transfer of a Lost lead: the new lead points back at the Lost one it was copied from.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS transferred_from_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;

-- A Lost lead may be transferred only once.
CREATE UNIQUE INDEX IF NOT EXISTS leads_transferred_from_lead_id_key
  ON leads (transferred_from_lead_id)
  WHERE transferred_from_lead_id IS NOT NULL;
