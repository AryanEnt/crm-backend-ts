-- Negotiation-stage categorization for Leads Pipeline cards.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS negotiation_tag TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS negotiation_remarks TEXT NOT NULL DEFAULT '';
