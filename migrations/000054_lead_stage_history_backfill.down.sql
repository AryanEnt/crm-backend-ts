DELETE FROM lead_stage_transitions
WHERE metadata->>'kind' = 'backfill';
