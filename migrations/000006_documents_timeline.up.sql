-- Documents lifecycle + unified CRM timeline

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'uploaded'
        CHECK (status IN ('requested', 'uploaded', 'verified', 'rejected', 'missing', 'expired')),
    ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rejected_reason TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

-- Backfill from existing rows
UPDATE documents SET
    doc_type = COALESCE(NULLIF(category, ''), doc_type, 'other'),
    uploaded_at = COALESCE(uploaded_at, created_at),
    status = CASE WHEN file_key = '' AND status = 'uploaded' THEN 'requested' ELSE status END
WHERE TRUE;

CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status);
CREATE INDEX IF NOT EXISTS documents_expires_at_idx ON documents (expires_at)
    WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_doc_type_idx ON documents (doc_type);

-- Mark expired where past expiry
UPDATE documents
SET status = 'expired'
WHERE expires_at IS NOT NULL
  AND expires_at < NOW()
  AND status IN ('uploaded', 'verified', 'requested');

CREATE TABLE timeline_events (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type         TEXT NOT NULL,
    title              TEXT NOT NULL DEFAULT '',
    body               TEXT NOT NULL DEFAULT '',
    occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    source             TEXT NOT NULL DEFAULT 'crm'
        CHECK (source IN ('crm', 'whatsapp', 'twilio', 'email', 'automation', 'external', 'system')),
    external_id        TEXT NOT NULL DEFAULT '',
    external_provider  TEXT NOT NULL DEFAULT '',
    lead_id            UUID REFERENCES leads(id) ON DELETE CASCADE,
    customer_id        UUID REFERENCES customers(id) ON DELETE CASCADE,
    deal_id            UUID REFERENCES deals(id) ON DELETE CASCADE,
    activity_id        UUID REFERENCES activities(id) ON DELETE SET NULL,
    document_id        UUID REFERENCES documents(id) ON DELETE SET NULL,
    metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT timeline_events_entity_chk CHECK (
        lead_id IS NOT NULL OR customer_id IS NOT NULL OR deal_id IS NOT NULL
        OR activity_id IS NOT NULL OR document_id IS NOT NULL
    )
);

CREATE INDEX timeline_events_customer_occurred_idx
    ON timeline_events (customer_id, occurred_at DESC)
    WHERE customer_id IS NOT NULL;
CREATE INDEX timeline_events_deal_occurred_idx
    ON timeline_events (deal_id, occurred_at DESC)
    WHERE deal_id IS NOT NULL;
CREATE INDEX timeline_events_lead_occurred_idx
    ON timeline_events (lead_id, occurred_at DESC)
    WHERE lead_id IS NOT NULL;
CREATE INDEX timeline_events_type_idx ON timeline_events (event_type);
CREATE INDEX timeline_events_source_idx ON timeline_events (source);
CREATE INDEX timeline_events_external_idx
    ON timeline_events (external_provider, external_id)
    WHERE external_id <> '';

-- Optional documents:edit permission for verify/reject workflows
INSERT INTO permissions (code, resource, action, description)
VALUES ('documents:edit', 'documents', 'edit', 'Edit and verify documents')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code = 'documents:edit'
  AND r.code IN ('super_admin', 'sales_manager', 'sales_executive')
ON CONFLICT DO NOTHING;
