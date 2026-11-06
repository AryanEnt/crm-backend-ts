-- Contacted-stage star rating + mandatory remarks (locked after leaving Contacted).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS contact_rating SMALLINT
    CHECK (contact_rating IS NULL OR (contact_rating >= 1 AND contact_rating <= 5)),
  ADD COLUMN IF NOT EXISTS contact_remarks TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_rated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_rated_by UUID REFERENCES users (id) ON DELETE SET NULL;
