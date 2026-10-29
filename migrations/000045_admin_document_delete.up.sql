-- Super Admin can delete documents (Team Lead already has documents:delete).
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT '11111111-1111-1111-1111-111111111111', p.id, 'organization'
FROM permissions p
WHERE p.code = 'documents:delete'
ON CONFLICT (role_id, permission_id) DO UPDATE SET scope = EXCLUDED.scope;
