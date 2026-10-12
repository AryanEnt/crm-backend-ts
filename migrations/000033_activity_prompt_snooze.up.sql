-- "Remind me later" on the due-activity prompt; NULL means the prompt shows once the activity is due.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS prompt_snoozed_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS activities_owner_open_due_idx
    ON activities (owner_user_id, COALESCE(start_at, due_at))
    WHERE status IN ('upcoming', 'due', 'overdue') AND lead_id IS NOT NULL;
