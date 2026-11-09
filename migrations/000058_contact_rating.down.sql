ALTER TABLE leads
  DROP COLUMN IF EXISTS contact_rated_by,
  DROP COLUMN IF EXISTS contact_rated_at,
  DROP COLUMN IF EXISTS contact_remarks,
  DROP COLUMN IF EXISTS contact_rating;
