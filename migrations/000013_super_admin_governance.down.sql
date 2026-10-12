-- Revert Super Admin to all-permissions (previous behavior)
DELETE FROM role_permissions
WHERE role_id = '11111111-1111-1111-1111-111111111111';

INSERT INTO role_permissions (role_id, permission_id)
SELECT '11111111-1111-1111-1111-111111111111', id FROM permissions;

UPDATE roles
SET description = 'Full platform access'
WHERE id = '11111111-1111-1111-1111-111111111111';

DELETE FROM role_permissions
WHERE role_id = '22222222-2222-2222-2222-222222222222'
  AND permission_id IN (
    SELECT id FROM permissions WHERE code IN (
      'settings:view', 'custom_fields:view', 'lead_sources:view',
      'activity_types:view', 'referrals:configure'
    )
  );

DELETE FROM permissions
WHERE code IN (
    'settings:view', 'settings:manage',
    'system:view',
    'custom_fields:view', 'custom_fields:manage',
    'lead_sources:view', 'lead_sources:manage',
    'activity_types:view', 'activity_types:manage',
    'referrals:configure'
);
