-- Revert Team Lead create grants and scopes

INSERT INTO role_permissions (role_id, permission_id)
SELECT '22222222-2222-2222-2222-222222222222', id FROM permissions
WHERE code IN (
    'leads:create', 'customers:create', 'deals:create', 'activities:create', 'documents:create'
)
ON CONFLICT DO NOTHING;

UPDATE roles
SET name = 'Sales Manager / Team Lead',
    description = 'Manages team pipeline and assignments'
WHERE id = '22222222-2222-2222-2222-222222222222';

ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_scope_chk;
ALTER TABLE role_permissions DROP COLUMN IF EXISTS scope;

ALTER TABLE users DROP COLUMN IF EXISTS phone;
