-- Auth & authorization foundation

CREATE TABLE roles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,
    resource    TEXT NOT NULL,
    action      TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT permissions_resource_action_unique UNIQUE (resource, action)
);

CREATE TABLE role_permissions (
    role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    role_id         UUID NOT NULL REFERENCES roles(id),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    deactivated_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT users_email_lower_chk CHECK (email = lower(email))
);

CREATE UNIQUE INDEX users_email_unique ON users (email);
CREATE INDEX users_role_id_idx ON users (role_id);
CREATE INDEX users_is_active_idx ON users (is_active);

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE teams (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    deactivated_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX teams_name_unique ON teams (lower(name));
CREATE INDEX teams_owner_user_id_idx ON teams (owner_user_id);
CREATE INDEX teams_is_active_idx ON teams (is_active);

CREATE TRIGGER teams_set_updated_at
    BEFORE UPDATE ON teams
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE team_members (
    team_id   UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id)
);

CREATE INDEX team_members_user_id_idx ON team_members (user_id);

CREATE TABLE refresh_sessions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_agent TEXT NOT NULL DEFAULT '',
    ip_address TEXT NOT NULL DEFAULT ''
);

CREATE INDEX refresh_sessions_user_id_idx ON refresh_sessions (user_id);
CREATE INDEX refresh_sessions_expires_at_idx ON refresh_sessions (expires_at);

CREATE TABLE audit_logs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address    TEXT NOT NULL DEFAULT '',
    user_agent    TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_logs_actor_user_id_idx ON audit_logs (actor_user_id);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);

-- Seed roles
INSERT INTO roles (id, code, name, description) VALUES
    ('11111111-1111-1111-1111-111111111111', 'super_admin', 'Super Admin', 'Full platform access'),
    ('22222222-2222-2222-2222-222222222222', 'sales_manager', 'Sales Manager / Team Lead', 'Manages team pipeline and assignments'),
    ('33333333-3333-3333-3333-333333333333', 'sales_executive', 'Sales Executive', 'Owns leads, deals, and activities'),
    ('44444444-4444-4444-4444-444444444444', 'sales_support', 'Sales Support', 'Assists with CRM operations with limited write access');

-- Seed permissions (resource:action)
INSERT INTO permissions (code, resource, action, description) VALUES
    ('users:view', 'users', 'view', 'View users'),
    ('users:create', 'users', 'create', 'Create users'),
    ('users:edit', 'users', 'edit', 'Edit users'),
    ('users:delete', 'users', 'delete', 'Deactivate users'),
    ('users:assign', 'users', 'assign', 'Assign roles and teams to users'),
    ('users:export', 'users', 'export', 'Export users'),
    ('users:manage', 'users', 'manage', 'Full user administration'),
    ('teams:view', 'teams', 'view', 'View teams'),
    ('teams:create', 'teams', 'create', 'Create teams'),
    ('teams:edit', 'teams', 'edit', 'Edit teams'),
    ('teams:delete', 'teams', 'delete', 'Deactivate teams'),
    ('teams:assign', 'teams', 'assign', 'Assign team members'),
    ('teams:manage', 'teams', 'manage', 'Full team administration'),
    ('roles:view', 'roles', 'view', 'View roles and permissions'),
    ('roles:manage', 'roles', 'manage', 'Manage role permission mappings'),
    ('audit:view', 'audit', 'view', 'View audit logs'),
    ('leads:view', 'leads', 'view', 'View leads'),
    ('leads:create', 'leads', 'create', 'Create leads'),
    ('leads:edit', 'leads', 'edit', 'Edit leads'),
    ('leads:delete', 'leads', 'delete', 'Delete leads'),
    ('leads:assign', 'leads', 'assign', 'Assign leads'),
    ('leads:export', 'leads', 'export', 'Export leads'),
    ('customers:view', 'customers', 'view', 'View customers'),
    ('customers:create', 'customers', 'create', 'Create customers'),
    ('customers:edit', 'customers', 'edit', 'Edit customers'),
    ('customers:delete', 'customers', 'delete', 'Delete customers'),
    ('customers:export', 'customers', 'export', 'Export customers'),
    ('deals:view', 'deals', 'view', 'View deals'),
    ('deals:create', 'deals', 'create', 'Create deals'),
    ('deals:edit', 'deals', 'edit', 'Edit deals'),
    ('deals:delete', 'deals', 'delete', 'Delete deals'),
    ('deals:assign', 'deals', 'assign', 'Assign deals'),
    ('deals:export', 'deals', 'export', 'Export deals'),
    ('pipelines:view', 'pipelines', 'view', 'View pipelines'),
    ('pipelines:manage', 'pipelines', 'manage', 'Manage pipelines and stages'),
    ('activities:view', 'activities', 'view', 'View activities'),
    ('activities:create', 'activities', 'create', 'Create activities'),
    ('activities:edit', 'activities', 'edit', 'Edit activities'),
    ('activities:delete', 'activities', 'delete', 'Delete activities'),
    ('documents:view', 'documents', 'view', 'View documents'),
    ('documents:create', 'documents', 'create', 'Upload documents'),
    ('documents:delete', 'documents', 'delete', 'Delete documents'),
    ('analytics:view', 'analytics', 'view', 'View analytics'),
    ('analytics:export', 'analytics', 'export', 'Export analytics'),
    ('reports:view', 'reports', 'view', 'View reports'),
    ('reports:export', 'reports', 'export', 'Export reports'),
    ('forecasts:view', 'forecasts', 'view', 'View forecasts'),
    ('targets:view', 'targets', 'view', 'View targets'),
    ('targets:manage', 'targets', 'manage', 'Manage targets'),
    ('automations:view', 'automations', 'view', 'View automations'),
    ('automations:manage', 'automations', 'manage', 'Manage automations');

-- Super Admin: all permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT '11111111-1111-1111-1111-111111111111', id FROM permissions;

-- Sales Manager
INSERT INTO role_permissions (role_id, permission_id)
SELECT '22222222-2222-2222-2222-222222222222', id FROM permissions
WHERE code IN (
    'users:view', 'users:assign',
    'teams:view', 'teams:edit', 'teams:assign',
    'roles:view',
    'leads:view', 'leads:create', 'leads:edit', 'leads:delete', 'leads:assign', 'leads:export',
    'customers:view', 'customers:create', 'customers:edit', 'customers:export',
    'deals:view', 'deals:create', 'deals:edit', 'deals:delete', 'deals:assign', 'deals:export',
    'pipelines:view',
    'activities:view', 'activities:create', 'activities:edit', 'activities:delete',
    'documents:view', 'documents:create', 'documents:delete',
    'analytics:view', 'analytics:export',
    'reports:view', 'reports:export',
    'forecasts:view',
    'targets:view', 'targets:manage'
);

-- Sales Executive
INSERT INTO role_permissions (role_id, permission_id)
SELECT '33333333-3333-3333-3333-333333333333', id FROM permissions
WHERE code IN (
    'teams:view',
    'leads:view', 'leads:create', 'leads:edit', 'leads:assign',
    'customers:view', 'customers:create', 'customers:edit',
    'deals:view', 'deals:create', 'deals:edit',
    'pipelines:view',
    'activities:view', 'activities:create', 'activities:edit',
    'documents:view', 'documents:create',
    'analytics:view',
    'reports:view',
    'forecasts:view',
    'targets:view'
);

-- Sales Support
INSERT INTO role_permissions (role_id, permission_id)
SELECT '44444444-4444-4444-4444-444444444444', id FROM permissions
WHERE code IN (
    'teams:view',
    'leads:view', 'leads:create', 'leads:edit',
    'customers:view', 'customers:create', 'customers:edit',
    'deals:view', 'deals:edit',
    'pipelines:view',
    'activities:view', 'activities:create', 'activities:edit',
    'documents:view', 'documents:create',
    'reports:view',
    'targets:view'
);
