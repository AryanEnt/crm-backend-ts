ALTER TABLE leads
  DROP COLUMN IF EXISTS negotiation_remarks,
  DROP COLUMN IF EXISTS negotiation_tag;
