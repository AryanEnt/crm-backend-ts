DROP INDEX IF EXISTS deals_lost_reason_idx;
ALTER TABLE deals DROP COLUMN IF EXISTS lost_reason;
