-- Calls workspace: topic notes a sales executive takes while preparing for or
-- holding a conversation with a lead or customer. Each note is mirrored once
-- into timeline_events (external_provider 'calls', external_id = note id).

CREATE TABLE IF NOT EXISTS conversation_notes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID REFERENCES leads(id) ON DELETE CASCADE,
    customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
    topic           TEXT NOT NULL,
    content         TEXT NOT NULL,
    author_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT conversation_notes_subject_chk CHECK ((lead_id IS NULL) <> (customer_id IS NULL)),
    CONSTRAINT conversation_notes_content_chk CHECK (length(btrim(content)) > 0),
    CONSTRAINT conversation_notes_topic_chk CHECK (topic ~ '^[a-z][a-z0-9_]{0,39}$')
);

CREATE INDEX IF NOT EXISTS conversation_notes_lead_idx
    ON conversation_notes (lead_id, created_at DESC)
    WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_notes_customer_idx
    ON conversation_notes (customer_id, created_at DESC)
    WHERE customer_id IS NOT NULL;

DROP TRIGGER IF EXISTS conversation_notes_set_updated_at ON conversation_notes;
CREATE TRIGGER conversation_notes_set_updated_at
    BEFORE UPDATE ON conversation_notes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
