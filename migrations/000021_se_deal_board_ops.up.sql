-- Ensure Sales Executives can operate their deal board (view/create/edit/move).
-- Idempotent re-grant after governance / scope migrations.

INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT '33333333-3333-3333-3333-333333333333', p.id, 'own'
FROM permissions p
WHERE p.code IN (
    'deals:view',
    'deals:create',
    'deals:edit',
    'leads:view',
    'leads:create',
    'leads:edit',
    'pipelines:view',
    'activities:view',
    'activities:create',
    'activities:edit'
)
ON CONFLICT (role_id, permission_id) DO UPDATE
SET scope = EXCLUDED.scope;

-- Team Lead retains team-scoped deal edits (stage moves for supervision).
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT '22222222-2222-2222-2222-222222222222', p.id, 'team'
FROM permissions p
WHERE p.code IN (
    'deals:view',
    'deals:edit',
    'pipelines:view'
)
ON CONFLICT (role_id, permission_id) DO UPDATE
SET scope = EXCLUDED.scope;
