-- Core CRM: ANZSCO, pipelines, leads, customers, deals, activities, notes, documents

CREATE TABLE anzsco_occupations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    occupation_group TEXT NOT NULL,
    skill_level     SMALLINT NOT NULL CHECK (skill_level BETWEEN 1 AND 5),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX anzsco_occupations_title_idx ON anzsco_occupations USING gin (to_tsvector('english', title));
CREATE INDEX anzsco_occupations_code_idx ON anzsco_occupations (code);
CREATE INDEX anzsco_occupations_group_idx ON anzsco_occupations (occupation_group);

CREATE TRIGGER anzsco_occupations_set_updated_at
    BEFORE UPDATE ON anzsco_occupations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pipelines (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'sales' CHECK (kind IN ('sales', 'leads')),
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX pipelines_name_unique ON pipelines (lower(name));
CREATE TRIGGER pipelines_set_updated_at
    BEFORE UPDATE ON pipelines
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pipeline_stages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id  UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     INT NOT NULL DEFAULT 0,
    is_won       BOOLEAN NOT NULL DEFAULT FALSE,
    is_lost      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pipeline_stages_pipeline_name_unique UNIQUE (pipeline_id, name)
);

CREATE INDEX pipeline_stages_pipeline_id_idx ON pipeline_stages (pipeline_id, position);
CREATE TRIGGER pipeline_stages_set_updated_at
    BEFORE UPDATE ON pipeline_stages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE customers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name           TEXT NOT NULL,
    email               TEXT,
    phone               TEXT,
    country             TEXT NOT NULL DEFAULT '',
    nationality         TEXT NOT NULL DEFAULT '',
    location            TEXT NOT NULL DEFAULT '',
    owner_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    team_id             UUID REFERENCES teams(id) ON DELETE SET NULL,
    source              TEXT NOT NULL DEFAULT '',
    priority            TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    tags                TEXT[] NOT NULL DEFAULT '{}',
    anzsco_id           UUID REFERENCES anzsco_occupations(id) ON DELETE SET NULL,
    -- professional profile
    occupation          TEXT NOT NULL DEFAULT '',
    job_title           TEXT NOT NULL DEFAULT '',
    employer            TEXT NOT NULL DEFAULT '',
    experience_years    NUMERIC(5,1),
    qualification       TEXT NOT NULL DEFAULT '',
    skills              TEXT[] NOT NULL DEFAULT '{}',
    -- sales profile
    pipeline_id         UUID REFERENCES pipelines(id) ON DELETE SET NULL,
    stage_id            UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
    potential_value     NUMERIC(14,2),
    expected_outcome    TEXT NOT NULL DEFAULT '',
    last_contacted_at   TIMESTAMPTZ,
    next_follow_up_at   TIMESTAMPTZ,
    notes               TEXT NOT NULL DEFAULT '',
    converted_from_lead_id UUID,
    is_archived         BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT customers_email_lower_chk CHECK (email IS NULL OR email = lower(email))
);

CREATE INDEX customers_owner_user_id_idx ON customers (owner_user_id);
CREATE INDEX customers_team_id_idx ON customers (team_id);
CREATE INDEX customers_email_idx ON customers (email);
CREATE INDEX customers_phone_idx ON customers (phone);
CREATE INDEX customers_full_name_idx ON customers USING gin (to_tsvector('english', full_name));
CREATE INDEX customers_tags_idx ON customers USING gin (tags);
CREATE INDEX customers_is_archived_idx ON customers (is_archived);

CREATE TRIGGER customers_set_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE leads (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name           TEXT NOT NULL,
    email               TEXT,
    phone               TEXT,
    country             TEXT NOT NULL DEFAULT '',
    nationality         TEXT NOT NULL DEFAULT '',
    location            TEXT NOT NULL DEFAULT '',
    owner_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    team_id             UUID REFERENCES teams(id) ON DELETE SET NULL,
    source              TEXT NOT NULL DEFAULT '',
    priority            TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    tags                TEXT[] NOT NULL DEFAULT '{}',
    anzsco_id           UUID REFERENCES anzsco_occupations(id) ON DELETE SET NULL,
    pipeline_id         UUID REFERENCES pipelines(id) ON DELETE SET NULL,
    stage_id            UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
    notes               TEXT NOT NULL DEFAULT '',
    -- professional (captured early)
    occupation          TEXT NOT NULL DEFAULT '',
    job_title           TEXT NOT NULL DEFAULT '',
    employer            TEXT NOT NULL DEFAULT '',
    experience_years    NUMERIC(5,1),
    qualification       TEXT NOT NULL DEFAULT '',
    skills              TEXT[] NOT NULL DEFAULT '{}',
    -- sales
    potential_value     NUMERIC(14,2),
    expected_outcome    TEXT NOT NULL DEFAULT '',
    last_activity_at    TIMESTAMPTZ,
    next_activity_at    TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'qualified', 'converted', 'archived', 'unqualified')),
    converted_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    converted_at        TIMESTAMPTZ,
    is_archived         BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT leads_email_lower_chk CHECK (email IS NULL OR email = lower(email))
);

CREATE INDEX leads_owner_user_id_idx ON leads (owner_user_id);
CREATE INDEX leads_team_id_idx ON leads (team_id);
CREATE INDEX leads_pipeline_stage_idx ON leads (pipeline_id, stage_id);
CREATE INDEX leads_source_idx ON leads (source);
CREATE INDEX leads_priority_idx ON leads (priority);
CREATE INDEX leads_anzsco_id_idx ON leads (anzsco_id);
CREATE INDEX leads_email_idx ON leads (email);
CREATE INDEX leads_phone_idx ON leads (phone);
CREATE INDEX leads_full_name_idx ON leads USING gin (to_tsvector('english', full_name));
CREATE INDEX leads_tags_idx ON leads USING gin (tags);
CREATE INDEX leads_is_archived_idx ON leads (is_archived);
CREATE INDEX leads_created_at_idx ON leads (created_at DESC);
CREATE INDEX leads_last_activity_at_idx ON leads (last_activity_at);
CREATE INDEX leads_next_activity_at_idx ON leads (next_activity_at);

CREATE TRIGGER leads_set_updated_at
    BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE customers
    ADD CONSTRAINT customers_converted_from_lead_fk
    FOREIGN KEY (converted_from_lead_id) REFERENCES leads(id) ON DELETE SET NULL;

CREATE TABLE deals (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    title             TEXT NOT NULL,
    owner_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    team_id           UUID REFERENCES teams(id) ON DELETE SET NULL,
    pipeline_id       UUID REFERENCES pipelines(id) ON DELETE SET NULL,
    stage_id          UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
    value             NUMERIC(14,2),
    currency          TEXT NOT NULL DEFAULT 'AUD',
    expected_close_at DATE,
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'archived')),
    notes             TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX deals_customer_id_idx ON deals (customer_id);
CREATE INDEX deals_owner_user_id_idx ON deals (owner_user_id);
CREATE INDEX deals_pipeline_stage_idx ON deals (pipeline_id, stage_id);
CREATE INDEX deals_status_idx ON deals (status);

CREATE TRIGGER deals_set_updated_at
    BEFORE UPDATE ON deals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Polymorphic timeline / activities (future: whatsapp, twilio, email)
CREATE TABLE activities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            TEXT NOT NULL CHECK (kind IN (
        'note', 'call', 'meeting', 'task', 'email', 'whatsapp', 'sms', 'system', 'stage_change', 'assignment'
    )),
    subject         TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('planned', 'completed', 'cancelled')),
    due_at          TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    lead_id         UUID REFERENCES leads(id) ON DELETE CASCADE,
    customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
    deal_id         UUID REFERENCES deals(id) ON DELETE CASCADE,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT activities_subject_entity_chk CHECK (
        lead_id IS NOT NULL OR customer_id IS NOT NULL OR deal_id IS NOT NULL
    )
);

CREATE INDEX activities_lead_id_idx ON activities (lead_id, created_at DESC);
CREATE INDEX activities_customer_id_idx ON activities (customer_id, created_at DESC);
CREATE INDEX activities_deal_id_idx ON activities (deal_id, created_at DESC);
CREATE INDEX activities_kind_idx ON activities (kind);
CREATE INDEX activities_due_at_idx ON activities (due_at);

CREATE TRIGGER activities_set_updated_at
    BEFORE UPDATE ON activities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    file_key        TEXT NOT NULL DEFAULT '',
    mime_type       TEXT NOT NULL DEFAULT '',
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    lead_id         UUID REFERENCES leads(id) ON DELETE CASCADE,
    customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
    deal_id         UUID REFERENCES deals(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT documents_entity_chk CHECK (
        lead_id IS NOT NULL OR customer_id IS NOT NULL OR deal_id IS NOT NULL
    )
);

CREATE INDEX documents_customer_id_idx ON documents (customer_id);
CREATE INDEX documents_lead_id_idx ON documents (lead_id);

CREATE TRIGGER documents_set_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed default lead + sales pipelines
INSERT INTO pipelines (id, name, kind, is_default) VALUES
    ('55555555-5555-5555-5555-555555555501', 'Lead Qualification', 'leads', TRUE),
    ('55555555-5555-5555-5555-555555555502', 'Sales Pipeline', 'sales', TRUE);

INSERT INTO pipeline_stages (id, pipeline_id, name, position) VALUES
    ('66666666-6666-6666-6666-666666666601', '55555555-5555-5555-5555-555555555501', 'New', 1),
    ('66666666-6666-6666-6666-666666666602', '55555555-5555-5555-5555-555555555501', 'Contacted', 2),
    ('66666666-6666-6666-6666-666666666603', '55555555-5555-5555-5555-555555555501', 'Qualified', 3),
    ('66666666-6666-6666-6666-666666666604', '55555555-5555-5555-5555-555555555501', 'Unqualified', 4),
    ('66666666-6666-6666-6666-666666666611', '55555555-5555-5555-5555-555555555502', 'Discovery', 1),
    ('66666666-6666-6666-6666-666666666612', '55555555-5555-5555-5555-555555555502', 'Proposal', 2),
    ('66666666-6666-6666-6666-666666666613', '55555555-5555-5555-5555-555555555502', 'Negotiation', 3),
    ('66666666-6666-6666-6666-666666666614', '55555555-5555-5555-5555-555555555502', 'Closed Won', 4),
    ('66666666-6666-6666-6666-666666666615', '55555555-5555-5555-5555-555555555502', 'Closed Lost', 5);

UPDATE pipeline_stages SET is_won = TRUE WHERE id = '66666666-6666-6666-6666-666666666614';
UPDATE pipeline_stages SET is_lost = TRUE WHERE id IN (
    '66666666-6666-6666-6666-666666666604',
    '66666666-6666-6666-6666-666666666615'
);

-- Representative ANZSCO reference rows (searchable by code/title)
INSERT INTO anzsco_occupations (code, title, occupation_group, skill_level) VALUES
    ('111111', 'Chief Executive or Managing Director', 'Managers', 1),
    ('132111', 'Corporate Services Manager', 'Managers', 1),
    ('221111', 'Accountant (General)', 'Professionals', 1),
    ('233211', 'Civil Engineer', 'Professionals', 1),
    ('233212', 'Geotechnical Engineer', 'Professionals', 1),
    ('233213', 'Quantity Surveyor', 'Professionals', 1),
    ('233214', 'Structural Engineer', 'Professionals', 1),
    ('233311', 'Electrical Engineer', 'Professionals', 1),
    ('233512', 'Mechanical Engineer', 'Professionals', 1),
    ('261111', 'ICT Business Analyst', 'Professionals', 1),
    ('261112', 'Systems Analyst', 'Professionals', 1),
    ('261311', 'Analyst Programmer', 'Professionals', 1),
    ('261312', 'Developer Programmer', 'Professionals', 1),
    ('261313', 'Software Engineer', 'Professionals', 1),
    ('261314', 'Software Tester', 'Professionals', 1),
    ('262111', 'Database Administrator', 'Professionals', 1),
    ('262112', 'ICT Security Specialist', 'Professionals', 1),
    ('263111', 'Computer Network and Systems Engineer', 'Professionals', 1),
    ('272511', 'Social Worker', 'Professionals', 1),
    ('254111', 'Midwife', 'Professionals', 1),
    ('254411', 'Nurse Practitioner', 'Professionals', 1),
    ('254418', 'Registered Nurse (Medical)', 'Professionals', 1),
    ('321111', 'Automotive Electrician', 'Technicians and Trades Workers', 3),
    ('321211', 'Motor Mechanic (General)', 'Technicians and Trades Workers', 3),
    ('331212', 'Carpenter', 'Technicians and Trades Workers', 3),
    ('334111', 'Plumber (General)', 'Technicians and Trades Workers', 3),
    ('341111', 'Electrician (General)', 'Technicians and Trades Workers', 3),
    ('351311', 'Chef', 'Technicians and Trades Workers', 2),
    ('411411', 'Enrolled Nurse', 'Community and Personal Service Workers', 2),
    ('511111', 'Contract Administrator', 'Clerical and Administrative Workers', 2);
