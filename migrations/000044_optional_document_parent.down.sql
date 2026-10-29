ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_entity_chk;
ALTER TABLE documents
    ADD CONSTRAINT documents_entity_chk CHECK (
        lead_id IS NOT NULL OR customer_id IS NOT NULL OR deal_id IS NOT NULL
    );
