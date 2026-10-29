-- Allow library documents with no lead/customer/deal link (Team Lead shared files).
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_entity_chk;
