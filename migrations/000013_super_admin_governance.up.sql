-- Separate SYSTEM ADMINISTRATION from CRM OPERATIONS for Super Admin.
-- Super Admin configures the platform; they do not operate the sales pipeline
-- unless an explicit operational permission is later granted via roles UI.

UPDATE roles
SET name = 'Super Admin',
    description = 'Platform governance, configuration, and administration — not a daily sales operating role'
WHERE id = '11111111-1111-1111-1111-111111111111';

-- Additional configuration / governance permissions
INSERT INTO permissions (code, resource, action, description)
VALUES
    ('settings:view', 'settings', 'view', 'View system settings'),
    ('settings:manage', 'settings', 'manage', 'Manage system settings'),
    ('system:view', 'system', 'view', 'View system activity and health'),
    ('custom_fields:view', 'custom_fields', 'view', 'View custom field definitions'),
    ('custom_fields:manage', 'custom_fields', 'manage', 'Manage custom field definitions'),
    ('lead_sources:view', 'lead_sources', 'view', 'View lead source configuration'),
    ('lead_sources:manage', 'lead_sources', 'manage', 'Manage lead source configuration'),
    ('activity_types:view', 'activity_types', 'view', 'View activity type configuration'),
    ('activity_types:manage', 'activity_types', 'manage', 'Manage activity type configuration'),
    ('referrals:configure', 'referrals', 'configure', 'Configure referral types, statuses, and relationships')
ON CONFLICT (code) DO NOTHING;

-- Wipe Super Admin grants, then assign governance-only set
DELETE FROM role_permissions
WHERE role_id = '11111111-1111-1111-1111-111111111111';

INSERT INTO role_permissions (role_id, permission_id)
SELECT '11111111-1111-1111-1111-111111111111', id
FROM permissions
WHERE code IN (
    -- Organization administration
    'users:view', 'users:create', 'users:edit', 'users:delete', 'users:assign', 'users:export', 'users:manage',
    'teams:view', 'teams:create', 'teams:edit', 'teams:delete', 'teams:assign', 'teams:manage',
    'roles:view', 'roles:manage',
    'audit:view',
    'settings:view', 'settings:manage',
    'system:view',

    -- CRM configuration (not operational writes)
    'pipelines:view', 'pipelines:manage',
    'custom_fields:view', 'custom_fields:manage',
    'lead_sources:view', 'lead_sources:manage',
    'activity_types:view', 'activity_types:manage',
    'automations:view', 'automations:manage',
    'communications:view', 'communications:manage',
    'referrals:view', 'referrals:configure',

    -- Organization-wide visibility / governance (read-only)
    'leads:view',
    'customers:view',
    'deals:view',
    'activities:view',
    'documents:view',
    'analytics:view', 'analytics:export',
    'reports:view', 'reports:export',
    'forecasts:view',
    'targets:view',
    'predictions:view'
);

-- Managers may view system settings (read) and referral config if they manage teams
INSERT INTO role_permissions (role_id, permission_id)
SELECT '22222222-2222-2222-2222-222222222222', id
FROM permissions
WHERE code IN (
    'settings:view',
    'custom_fields:view',
    'lead_sources:view',
    'activity_types:view',
    'referrals:configure'
)
ON CONFLICT DO NOTHING;
