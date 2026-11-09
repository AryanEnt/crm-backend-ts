-- Next follow-up plan notes on Leads Pipeline (Contacted → Lost).
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS next_follow_up_remarks TEXT NOT NULL DEFAULT '';
