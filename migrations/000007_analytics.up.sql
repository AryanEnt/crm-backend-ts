-- Analytics performance indexes + controlled verification seed

CREATE INDEX IF NOT EXISTS deals_pipeline_stage_status_idx
    ON deals (pipeline_id, stage_id, status)
    WHERE pipeline_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS deals_created_at_idx ON deals (created_at DESC);
CREATE INDEX IF NOT EXISTS deals_owner_created_idx ON deals (owner_user_id, created_at DESC)
    WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_team_created_idx ON deals (team_id, created_at DESC)
    WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_source_created_idx ON deals (source, created_at DESC)
    WHERE source <> '';

CREATE INDEX IF NOT EXISTS leads_pipeline_stage_status_idx
    ON leads (pipeline_id, stage_id, status)
    WHERE pipeline_id IS NOT NULL AND is_archived = FALSE;
CREATE INDEX IF NOT EXISTS leads_owner_created_idx ON leads (owner_user_id, created_at DESC)
    WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_team_created_idx ON leads (team_id, created_at DESC)
    WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_converted_at_idx ON leads (converted_at DESC)
    WHERE converted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS deal_stage_transitions_from_exited_idx
    ON deal_stage_transitions (from_stage_id, exited_at DESC)
    WHERE from_stage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deal_stage_transitions_to_exited_idx
    ON deal_stage_transitions (to_stage_id, exited_at DESC);
CREATE INDEX IF NOT EXISTS deal_stage_transitions_pipeline_exited_idx
    ON deal_stage_transitions (to_pipeline_id, exited_at DESC)
    WHERE to_pipeline_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS activities_created_at_idx ON activities (created_at DESC);
CREATE INDEX IF NOT EXISTS activities_owner_created_idx ON activities (owner_user_id, created_at DESC)
    WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activities_kind_created_idx ON activities (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS activities_completed_at_idx ON activities (completed_at DESC)
    WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS customers_anzsco_idx ON customers (anzsco_id)
    WHERE anzsco_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_source_created_idx ON customers (source, created_at DESC)
    WHERE source <> '';

-- Controlled fixture. Filter: pipeline=Sales Pipeline, source=analytics_seed,
-- date range covering 2026-01-15 .. 2026-01-31.
-- Expected Discovery: entered=10 left=7 conversion=70 dropOff=30 avgSeconds=86400
-- Proposal: entered=7 left=4 conversion≈57.14 avgSeconds=172800
-- Negotiation: entered=4 left=2 conversion=50 avgSeconds=259200
-- Closed Won entered=1; Closed Lost entered=1

DO $$
DECLARE
    admin_id UUID;
    team_id UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
    cust_id UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
    pipe_id UUID := '55555555-5555-5555-5555-555555555502';
    st_d UUID := '66666666-6666-6666-6666-666666666611';
    st_p UUID := '66666666-6666-6666-6666-666666666612';
    st_n UUID := '66666666-6666-6666-6666-666666666613';
    st_w UUID := '66666666-6666-6666-6666-666666666614';
    st_l UUID := '66666666-6666-6666-6666-666666666615';
    base_ts TIMESTAMPTZ := TIMESTAMPTZ '2026-01-15 00:00:00+00';
    i INT;
    deal_id UUID;
    anzsco UUID;
    final_stage UUID;
    final_status TEXT;
    stage_entered TIMESTAMPTZ;
BEGIN
    SELECT id INTO admin_id FROM users ORDER BY created_at ASC LIMIT 1;
    IF admin_id IS NULL THEN
        RETURN;
    END IF;

    SELECT id INTO anzsco FROM anzsco_occupations WHERE code = '261313' LIMIT 1;

    INSERT INTO teams (id, name, description, owner_user_id, is_active)
    VALUES (team_id, 'Analytics Seed Team', 'Controlled fixture for analytics verification', admin_id, TRUE)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE;

    INSERT INTO team_members (team_id, user_id)
    VALUES (team_id, admin_id)
    ON CONFLICT DO NOTHING;

    INSERT INTO customers (
        id, full_name, email, phone, country, source, priority,
        owner_user_id, team_id, anzsco_id, pipeline_id, stage_id, created_at, updated_at
    ) VALUES (
        cust_id, 'Analytics Seed Customer', 'analytics.seed@crm.local', '+61000000001',
        'Australia', 'analytics_seed', 'medium',
        admin_id, team_id, anzsco, pipe_id, st_d, base_ts, base_ts
    )
    ON CONFLICT (id) DO UPDATE SET
        source = EXCLUDED.source,
        owner_user_id = EXCLUDED.owner_user_id,
        team_id = EXCLUDED.team_id;

    DELETE FROM deal_stage_transitions t
        USING deals d
        WHERE t.deal_id = d.id AND d.source = 'analytics_seed';
    DELETE FROM activities a
        USING deals d
        WHERE a.deal_id = d.id AND d.source = 'analytics_seed';
    DELETE FROM activities
        WHERE customer_id = cust_id AND subject LIKE 'Seed follow-up%';
    DELETE FROM deals WHERE source = 'analytics_seed';

    FOR i IN 1..10 LOOP
        deal_id := ('cccccccc-cccc-cccc-cccc-' || lpad(i::text, 12, '0'))::uuid;

        IF i <= 3 THEN
            final_stage := st_d; final_status := 'open'; stage_entered := base_ts;
        ELSIF i <= 6 THEN
            final_stage := st_p; final_status := 'open'; stage_entered := base_ts + INTERVAL '1 day';
        ELSIF i <= 8 THEN
            final_stage := st_n; final_status := 'open'; stage_entered := base_ts + INTERVAL '3 days';
        ELSIF i = 9 THEN
            final_stage := st_w; final_status := 'won'; stage_entered := base_ts + INTERVAL '6 days';
        ELSE
            final_stage := st_l; final_status := 'lost'; stage_entered := base_ts + INTERVAL '6 days';
        END IF;

        INSERT INTO deals (
            id, customer_id, title, owner_user_id, team_id, pipeline_id, stage_id,
            value, currency, source, priority, status, stage_entered_at, created_at, updated_at
        ) VALUES (
            deal_id, cust_id, 'Seed Deal ' || i, admin_id, team_id, pipe_id, final_stage,
            (10000 * i)::numeric, 'AUD', 'analytics_seed', 'medium', final_status,
            stage_entered, base_ts, stage_entered
        );

        -- Enter Discovery
        INSERT INTO deal_stage_transitions (
            id, deal_id, to_pipeline_id, to_stage_id, actor_user_id,
            entered_at, exited_at, duration_seconds, metadata, created_at
        ) VALUES (
            gen_random_uuid(), deal_id, pipe_id, st_d, admin_id,
            NULL, base_ts, 0, '{"kind":"created","fixture":true}'::jsonb, base_ts
        );

        IF i >= 4 THEN
            -- Leave Discovery after 1 day
            INSERT INTO deal_stage_transitions (
                id, deal_id, from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id, actor_user_id,
                entered_at, exited_at, duration_seconds, metadata, created_at
            ) VALUES (
                gen_random_uuid(), deal_id, pipe_id, st_d, pipe_id, st_p, admin_id,
                base_ts, base_ts + INTERVAL '1 day', 86400,
                '{"fixture":true}'::jsonb, base_ts + INTERVAL '1 day'
            );
        END IF;

        IF i >= 7 THEN
            -- Leave Proposal after 2 days
            INSERT INTO deal_stage_transitions (
                id, deal_id, from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id, actor_user_id,
                entered_at, exited_at, duration_seconds, metadata, created_at
            ) VALUES (
                gen_random_uuid(), deal_id, pipe_id, st_p, pipe_id, st_n, admin_id,
                base_ts + INTERVAL '1 day', base_ts + INTERVAL '3 days', 172800,
                '{"fixture":true}'::jsonb, base_ts + INTERVAL '3 days'
            );
        END IF;

        IF i = 9 THEN
            INSERT INTO deal_stage_transitions (
                id, deal_id, from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id, actor_user_id,
                entered_at, exited_at, duration_seconds, metadata, created_at
            ) VALUES (
                gen_random_uuid(), deal_id, pipe_id, st_n, pipe_id, st_w, admin_id,
                base_ts + INTERVAL '3 days', base_ts + INTERVAL '6 days', 259200,
                '{"fixture":true}'::jsonb, base_ts + INTERVAL '6 days'
            );
        ELSIF i = 10 THEN
            INSERT INTO deal_stage_transitions (
                id, deal_id, from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id, actor_user_id,
                entered_at, exited_at, duration_seconds, metadata, created_at
            ) VALUES (
                gen_random_uuid(), deal_id, pipe_id, st_n, pipe_id, st_l, admin_id,
                base_ts + INTERVAL '3 days', base_ts + INTERVAL '6 days', 259200,
                '{"fixture":true}'::jsonb, base_ts + INTERVAL '6 days'
            );
        END IF;

        INSERT INTO activities (
            id, kind, subject, title, body, status, completed_at,
            actor_user_id, owner_user_id, deal_id, customer_id, created_at, updated_at
        ) VALUES (
            gen_random_uuid(), 'call', 'Seed follow-up ' || i, 'Seed follow-up ' || i,
            'Analytics fixture activity', 'completed', base_ts + INTERVAL '2 hours',
            admin_id, admin_id, deal_id, cust_id, base_ts + INTERVAL '2 hours', base_ts + INTERVAL '2 hours'
        );
    END LOOP;
END $$;
