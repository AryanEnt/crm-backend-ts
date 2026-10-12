-- Referral Management: structured referrals separate from lead source

CREATE TABLE referral_referrer_types (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER referral_referrer_types_set_updated_at
    BEFORE UPDATE ON referral_referrer_types
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE referral_relationships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER referral_relationships_set_updated_at
    BEFORE UPDATE ON referral_relationships
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE referral_statuses (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    is_converted BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER referral_statuses_set_updated_at
    BEFORE UPDATE ON referral_statuses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Structured partners for partner/agent referrers
CREATE TABLE referral_partners (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    email       TEXT,
    phone       TEXT,
    company     TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT referral_partners_email_lower_chk CHECK (email IS NULL OR email = lower(email))
);

CREATE INDEX referral_partners_name_idx ON referral_partners USING gin (to_tsvector('english', name));
CREATE INDEX referral_partners_is_active_idx ON referral_partners (is_active);

CREATE TRIGGER referral_partners_set_updated_at
    BEFORE UPDATE ON referral_partners
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE referrals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id                 UUID REFERENCES leads(id) ON DELETE SET NULL,
    customer_id             UUID REFERENCES customers(id) ON DELETE SET NULL,
    referrer_type_id        UUID NOT NULL REFERENCES referral_referrer_types(id),
    referrer_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    referrer_customer_id    UUID REFERENCES customers(id) ON DELETE SET NULL,
    referrer_partner_id     UUID REFERENCES referral_partners(id) ON DELETE SET NULL,
    -- Display / free-text name when type is Other or when a linked entity has a display override
    referrer_name           TEXT NOT NULL DEFAULT '',
    relationship_id         UUID REFERENCES referral_relationships(id) ON DELETE SET NULL,
    referral_date           DATE NOT NULL DEFAULT CURRENT_DATE,
    -- Distinct from leads.source / customers.source (lead source remains e.g. "Referral")
    referral_source         TEXT NOT NULL DEFAULT '',
    notes                   TEXT NOT NULL DEFAULT '',
    status_id               UUID NOT NULL REFERENCES referral_statuses(id),
    referral_code           TEXT,
    created_by_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT referrals_subject_chk CHECK (lead_id IS NOT NULL OR customer_id IS NOT NULL),
    CONSTRAINT referrals_referrer_link_chk CHECK (
        referrer_user_id IS NOT NULL
        OR referrer_customer_id IS NOT NULL
        OR referrer_partner_id IS NOT NULL
        OR length(trim(referrer_name)) > 0
    )
);

CREATE UNIQUE INDEX referrals_lead_id_unique ON referrals (lead_id) WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX referrals_customer_id_unique ON referrals (customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX referrals_code_unique ON referrals (lower(referral_code)) WHERE referral_code IS NOT NULL AND referral_code <> '';

CREATE INDEX referrals_referrer_type_id_idx ON referrals (referrer_type_id);
CREATE INDEX referrals_referrer_user_id_idx ON referrals (referrer_user_id);
CREATE INDEX referrals_referrer_customer_id_idx ON referrals (referrer_customer_id);
CREATE INDEX referrals_referrer_partner_id_idx ON referrals (referrer_partner_id);
CREATE INDEX referrals_status_id_idx ON referrals (status_id);
CREATE INDEX referrals_referral_date_idx ON referrals (referral_date DESC);
CREATE INDEX referrals_created_at_idx ON referrals (created_at DESC);

CREATE TRIGGER referrals_set_updated_at
    BEFORE UPDATE ON referrals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed configurable catalogs
INSERT INTO referral_referrer_types (code, name, description, sort_order) VALUES
    ('existing_customer', 'Existing Customer', 'An existing CRM customer', 10),
    ('sales_executive', 'Sales Executive', 'Internal sales executive / user', 20),
    ('employee', 'Employee', 'Internal employee / user', 30),
    ('partner', 'Partner', 'External partner organization or contact', 40),
    ('agent', 'Agent', 'External agent', 50),
    ('other', 'Other', 'Unstructured or other referrer', 90);

INSERT INTO referral_relationships (code, name, description, sort_order) VALUES
    ('friend', 'Friend', '', 10),
    ('family', 'Family', '', 20),
    ('colleague', 'Colleague', '', 30),
    ('partner', 'Partner', '', 40),
    ('agent', 'Agent', '', 50),
    ('other', 'Other', '', 90);

INSERT INTO referral_statuses (code, name, description, is_converted, sort_order) VALUES
    ('active', 'Active', 'Referral is active in pipeline', FALSE, 10),
    ('unconverted', 'Unconverted', 'Referral has not converted', FALSE, 20),
    ('converted', 'Converted', 'Referred lead converted to customer', TRUE, 30),
    ('cancelled', 'Cancelled', 'Referral cancelled', FALSE, 90);

INSERT INTO permissions (code, resource, action, description)
VALUES
    ('referrals:view', 'referrals', 'view', 'View referral records'),
    ('referrals:create', 'referrals', 'create', 'Create referral records'),
    ('referrals:edit', 'referrals', 'edit', 'Edit referral records'),
    ('referrals:manage', 'referrals', 'manage', 'Full referral administration')
ON CONFLICT (code) DO NOTHING;

-- Super Admin: full
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('referrals:view', 'referrals:create', 'referrals:edit', 'referrals:manage')
  AND r.code = 'super_admin'
ON CONFLICT DO NOTHING;

-- Sales Manager: view/create/edit (team-scoped in API)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('referrals:view', 'referrals:create', 'referrals:edit')
  AND r.code = 'sales_manager'
ON CONFLICT DO NOTHING;

-- Sales Executive: view/create/edit for owned records
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('referrals:view', 'referrals:create', 'referrals:edit')
  AND r.code = 'sales_executive'
ON CONFLICT DO NOTHING;

-- Sales Support: view only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code = 'referrals:view'
  AND r.code = 'sales_support'
ON CONFLICT DO NOTHING;
