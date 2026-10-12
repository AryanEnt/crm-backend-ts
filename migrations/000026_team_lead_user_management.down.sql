UPDATE role_permissions rp
SET scope = 'organization'
FROM roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code IN ('sales_executive', 'sales_support')
  AND p.code = 'teams:view';

INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT '22222222-2222-2222-2222-222222222222', p.id, 'team'
FROM permissions p
WHERE p.code IN ('users:assign', 'teams:edit', 'teams:assign')
ON CONFLICT (role_id, permission_id) DO NOTHING;

DELETE FROM role_permissions
WHERE role_id = '22222222-2222-2222-2222-222222222222'
  AND permission_id IN (
      SELECT id FROM permissions WHERE code IN ('users:create', 'users:edit', 'users:delete')
  );
