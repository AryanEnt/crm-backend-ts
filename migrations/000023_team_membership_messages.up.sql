-- Align single-team membership trigger messages with API conflict copy.

CREATE OR REPLACE FUNCTION enforce_single_team_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    role_code text;
    person_name text;
    other_name text;
BEGIN
    SELECT r.code, u.full_name
      INTO role_code, person_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
     WHERE u.id = NEW.user_id;

    IF role_code = 'super_admin' THEN
        RAISE EXCEPTION 'Super Admin cannot be a team member or Team Lead'
            USING ERRCODE = '23514';
    END IF;

    IF role_code IN ('sales_executive', 'sales_manager') THEN
        SELECT t.name
          INTO other_name
          FROM team_members tm
          JOIN teams t ON t.id = tm.team_id
         WHERE tm.user_id = NEW.user_id
           AND tm.team_id <> NEW.team_id
         LIMIT 1;

        IF other_name IS NOT NULL THEN
            IF role_code = 'sales_manager' THEN
                RAISE EXCEPTION 'Team Lead is already assigned to another team.'
                    USING ERRCODE = '23514';
            END IF;
            RAISE EXCEPTION 'Sales Executive is already assigned to another team.'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
