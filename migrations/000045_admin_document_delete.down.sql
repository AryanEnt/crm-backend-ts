DELETE FROM role_permissions
WHERE role_id = '11111111-1111-1111-1111-111111111111'
  AND permission_id = (SELECT id FROM permissions WHERE code = 'documents:delete');
