-- Team-scoped Sales Executive management:
-- permission data scopes (own / team / organization),
-- phone on users, Team Lead supervisory (view-only) grants.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';

ALTER TABLE role_permissions
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'organization';

ALTER TABLE role_permissions
    DROP CONSTRAINT IF EXISTS role_permissions_scope_chk;

ALTER TABLE role_permissions
    ADD CONSTRAINT role_permissions_scope_chk
    CHECK (scope IN ('own', 'team', 'organization'));

-- Team Lead display name (role code remains sales_manager)
UPDATE roles
SET name = 'Team Lead',
    description = 'Supervises Sales Executives within their assigned team — views team CRM data without operational create by default'
WHERE id = '22222222-2222-2222-2222-222222222222';

-- Strip Team Lead operational create permissions (view/supervise only by default)
DELETE FROM role_permissions
WHERE role_id = '22222222-2222-2222-2222-222222222222'
  AND permission_id IN (
      SELECT id FROM permissions
      WHERE code IN (
          'leads:create', 'customers:create', 'deals:create', 'activities:create',
          'documents:create'
      )
  );

-- Default all existing grants to organization, then refine by role
UPDATE role_permissions SET scope = 'organization';

-- Super Admin: organization-wide governance visibility
UPDATE role_permissions rp
SET scope = 'organization'
FROM roles r
WHERE rp.role_id = r.id AND r.code = 'super_admin';

-- Team Lead: team-scoped visibility / supervision
UPDATE role_permissions rp
SET scope = 'team'
FROM roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code = 'sales_manager'
  AND p.code IN (
      'leads:view', 'leads:edit', 'leads:delete', 'leads:assign', 'leads:export',
      'customers:view', 'customers:edit', 'customers:export',
      'deals:view', 'deals:edit', 'deals:delete', 'deals:assign', 'deals:export',
      'activities:view', 'activities:edit', 'activities:delete',
      'documents:view', 'documents:delete',
      'analytics:view', 'analytics:export',
      'reports:view', 'reports:export',
      'forecasts:view',
      'targets:view', 'targets:manage',
      'pipelines:view',
      'users:view', 'users:assign',
      'teams:view', 'teams:edit', 'teams:assign',
      'referrals:view', 'referrals:configure'
  );

-- Sales Executive: own-record scope
UPDATE role_permissions rp
SET scope = 'own'
FROM roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code = 'sales_executive'
  AND p.resource IN (
      'leads', 'customers', 'deals', 'activities', 'documents',
      'analytics', 'reports', 'forecasts', 'targets', 'referrals', 'pipelines'
  );

-- Sales Support: own-record scope for operational CRM
UPDATE role_permissions rp
SET scope = 'own'
FROM roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code = 'sales_support'
  AND p.resource IN (
      'leads', 'customers', 'deals', 'activities', 'documents', 'targets', 'pipelines'
  );

-- Ensure Team Lead retains supervisory view permissions (idempotent)
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT '22222222-2222-2222-2222-222222222222', p.id, 'team'
FROM permissions p
WHERE p.code IN (
    'leads:view', 'leads:export',
    'customers:view', 'customers:export',
    'deals:view', 'deals:export',
    'activities:view',
    'documents:view',
    'analytics:view', 'analytics:export',
    'reports:view', 'reports:export',
    'forecasts:view',
    'targets:view',
    'pipelines:view',
    'users:view',
    'teams:view'
)
ON CONFLICT (role_id, permission_id) DO UPDATE SET scope = EXCLUDED.scope;
