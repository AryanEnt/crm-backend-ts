-- Async phone format validation + duplicate detection on leads.
-- Original phone text is never overwritten; normalized E.164 lives in phone_normalized.

ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS phone_country_code TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS phone_validation_status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS phone_normalized TEXT,
    ADD COLUMN IF NOT EXISTS phone_validation_message TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS phone_duplicate_lead_ids UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS phone_validated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS phone_last_notified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS phone_validation_version BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS phone_input_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_phone_validation_status_chk;
ALTER TABLE leads
    ADD CONSTRAINT leads_phone_validation_status_chk
    CHECK (phone_validation_status IN (
        'pending', 'valid', 'invalid', 'duplicate', 'invalid_duplicate', 'needs_review'
    ));

UPDATE leads
SET created_by_user_id = owner_user_id
WHERE created_by_user_id IS NULL AND owner_user_id IS NOT NULL;

-- Existing numbers need a pass; blank phones are already "fine" (no issue to chase).
UPDATE leads
SET phone_validation_status = CASE
        WHEN phone IS NULL OR btrim(phone) = '' THEN 'valid'
        ELSE 'pending'
    END,
    phone_validation_message = CASE
        WHEN phone IS NULL OR btrim(phone) = '' THEN ''
        ELSE 'Queued for validation'
    END
WHERE phone_validation_version = 0
  AND phone_validated_at IS NULL;

CREATE INDEX IF NOT EXISTS leads_phone_normalized_idx
    ON leads (phone_normalized)
    WHERE phone_normalized IS NOT NULL AND is_archived = FALSE;

CREATE INDEX IF NOT EXISTS leads_phone_validation_pending_idx
    ON leads (updated_at)
    WHERE phone_validation_status = 'pending';

CREATE INDEX IF NOT EXISTS leads_phone_issue_notify_idx
    ON leads (phone_last_notified_at NULLS FIRST, created_at)
    WHERE phone_validation_status IN ('invalid', 'duplicate', 'invalid_duplicate', 'needs_review')
      AND is_archived = FALSE;

CREATE INDEX IF NOT EXISTS leads_created_by_user_id_idx
    ON leads (created_by_user_id)
    WHERE created_by_user_id IS NOT NULL;
