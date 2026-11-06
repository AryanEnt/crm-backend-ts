-- Overdue document send-by remarks on Nurturing leads (append-only history + latest on lead).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS document_delay_remarks TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS document_delay_remarks_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS document_delay_remarks_by UUID REFERENCES users (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS lead_document_delay_remarks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
    body            TEXT NOT NULL,
    author_user_id  UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lead_document_delay_remarks_lead_idx
  ON lead_document_delay_remarks (lead_id, created_at DESC);
