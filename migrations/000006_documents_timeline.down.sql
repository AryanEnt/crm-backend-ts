DROP INDEX IF EXISTS timeline_events_external_idx;
DROP INDEX IF EXISTS timeline_events_source_idx;
DROP INDEX IF EXISTS timeline_events_type_idx;
DROP INDEX IF EXISTS timeline_events_lead_occurred_idx;
DROP INDEX IF EXISTS timeline_events_deal_occurred_idx;
DROP INDEX IF EXISTS timeline_events_customer_occurred_idx;
DROP TABLE IF EXISTS timeline_events;

DROP INDEX IF EXISTS documents_doc_type_idx;
DROP INDEX IF EXISTS documents_expires_at_idx;
DROP INDEX IF EXISTS documents_status_idx;

ALTER TABLE documents
    DROP COLUMN IF EXISTS doc_type,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS requested_at,
    DROP COLUMN IF EXISTS uploaded_at,
    DROP COLUMN IF EXISTS expires_at,
    DROP COLUMN IF EXISTS verified_by,
    DROP COLUMN IF EXISTS verified_at,
    DROP COLUMN IF EXISTS rejected_reason,
    DROP COLUMN IF EXISTS storage_provider,
    DROP COLUMN IF EXISTS notes;

DELETE FROM role_permissions WHERE permission_id IN (
    SELECT id FROM permissions WHERE code = 'documents:edit'
);
DELETE FROM permissions WHERE code = 'documents:edit';
