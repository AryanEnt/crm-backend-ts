ALTER TABLE deals
    ADD COLUMN IF NOT EXISTS lost_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS deals_lost_reason_idx ON deals (lost_reason)
    WHERE lost_reason <> '';
