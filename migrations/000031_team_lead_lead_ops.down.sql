-- Back to the supervisory Team Lead of 000015 (no lead or activity create).
DELETE FROM role_permissions
WHERE role_id = '22222222-2222-2222-2222-222222222222'
  AND permission_id IN (
      SELECT id FROM permissions WHERE code IN ('leads:create', 'activities:create')
  );
