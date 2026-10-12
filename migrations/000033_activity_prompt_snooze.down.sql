DROP INDEX IF EXISTS activities_owner_open_due_idx;
ALTER TABLE activities DROP COLUMN IF EXISTS prompt_snoozed_until;
