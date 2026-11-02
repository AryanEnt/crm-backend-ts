DROP INDEX IF EXISTS leads_created_by_user_id_idx;
DROP INDEX IF EXISTS leads_phone_issue_notify_idx;
DROP INDEX IF EXISTS leads_phone_validation_pending_idx;
DROP INDEX IF EXISTS leads_phone_normalized_idx;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_phone_validation_status_chk;

ALTER TABLE leads
    DROP COLUMN IF EXISTS phone_input_hash,
    DROP COLUMN IF EXISTS phone_validation_version,
    DROP COLUMN IF EXISTS phone_last_notified_at,
    DROP COLUMN IF EXISTS phone_validated_at,
    DROP COLUMN IF EXISTS phone_duplicate_lead_ids,
    DROP COLUMN IF EXISTS phone_validation_message,
    DROP COLUMN IF EXISTS phone_normalized,
    DROP COLUMN IF EXISTS phone_validation_status,
    DROP COLUMN IF EXISTS phone_country_code,
    DROP COLUMN IF EXISTS created_by_user_id;
