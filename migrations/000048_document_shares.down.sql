DELETE FROM role_permissions
WHERE role_id = '11111111-1111-1111-1111-111111111111'
  AND permission_id = (SELECT id FROM permissions WHERE code = 'documents:create');

DROP TABLE IF EXISTS document_shares;

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_share_scope_chk;

ALTER TABLE documents
  DROP COLUMN IF EXISTS share_scope,
  DROP COLUMN IF EXISTS original_filename;
