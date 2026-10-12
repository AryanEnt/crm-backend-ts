-- Team leadership is a Team Lead (sales_manager) membership, not an owner.
ALTER TABLE teams RENAME COLUMN owner_user_id TO team_lead_user_id;
ALTER INDEX IF EXISTS teams_owner_user_id_idx RENAME TO teams_team_lead_user_id_idx;

-- Super Admin is organization-wide and is not a team member or Team Lead.
DELETE FROM team_members tm
USING users u
JOIN roles r ON r.id = u.role_id
WHERE tm.user_id = u.id AND r.code = 'super_admin';

UPDATE teams t
SET team_lead_user_id = NULL
FROM users u
JOIN roles r ON r.id = u.role_id
WHERE t.team_lead_user_id = u.id AND r.code = 'super_admin';

-- A Team Lead must be a sales_manager. Anyone else stored in the old owner column
-- stays a member if they already are, but is not the Team Lead.
UPDATE teams t
SET team_lead_user_id = NULL
WHERE t.team_lead_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.id = t.team_lead_user_id AND r.code = 'sales_manager'
  );

INSERT INTO team_members (team_id, user_id)
SELECT t.id, t.team_lead_user_id
FROM teams t
WHERE t.team_lead_user_id IS NOT NULL
ON CONFLICT DO NOTHING;
