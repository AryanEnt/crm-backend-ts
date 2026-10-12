-- Lead-only CRM: Team Leads work leads in their team (create, edit, assign, move)
-- and log activities. Grants stay team-scoped; data-scope checks are unchanged.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT '22222222-2222-2222-2222-222222222222', p.id, 'team'
FROM permissions p
WHERE p.code IN (
    'leads:view',
    'leads:create',
    'leads:edit',
    'leads:assign',
    'activities:view',
    'activities:create',
    'activities:edit',
    'pipelines:view'
)
ON CONFLICT (role_id, permission_id) DO UPDATE SET scope = EXCLUDED.scope;
