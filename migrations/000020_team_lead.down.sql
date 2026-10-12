ALTER INDEX IF EXISTS teams_team_lead_user_id_idx RENAME TO teams_owner_user_id_idx;
ALTER TABLE teams RENAME COLUMN team_lead_user_id TO owner_user_id;
