-- Only Team Leads (and Super Admin) may create/upload documents.
-- Sales Executives see a document only when listed on document_viewers.

INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT '22222222-2222-2222-2222-222222222222', p.id, 'team'
FROM permissions p
WHERE p.code = 'documents:create'
ON CONFLICT (role_id, permission_id) DO UPDATE SET scope = EXCLUDED.scope;

DELETE FROM role_permissions
WHERE role_id IN (
    SELECT id FROM roles WHERE code IN ('sales_executive', 'sales_support')
  )
  AND permission_id = (SELECT id FROM permissions WHERE code = 'documents:create');

CREATE TABLE IF NOT EXISTS document_viewers (
    document_id UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS document_viewers_user_id_idx ON document_viewers (user_id);
