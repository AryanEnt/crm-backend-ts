DROP TABLE IF EXISTS document_viewers;

INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'own'
FROM roles r
CROSS JOIN permissions p
WHERE r.code IN ('sales_executive', 'sales_support')
  AND p.code = 'documents:create'
ON CONFLICT (role_id, permission_id) DO UPDATE SET scope = EXCLUDED.scope;

DELETE FROM role_permissions
WHERE role_id = '22222222-2222-2222-2222-222222222222'
  AND permission_id = (SELECT id FROM permissions WHERE code = 'documents:create');
