-- Seed an initial stage-history row for leads that already have a stage but never
-- got a lead_stage_transitions entry (created before recordInitialStage, or a
-- failed insert). Uses stage_entered_at when present, otherwise created_at.
-- Does not invent intermediate transitions.

INSERT INTO lead_stage_transitions (
    id, lead_id, to_pipeline_id, to_stage_id, actor_user_id,
    from_stage_entered_at, entered_at, duration_seconds, metadata
)
SELECT
    gen_random_uuid(),
    l.id,
    l.pipeline_id,
    l.stage_id,
    COALESCE(l.created_by_user_id, l.owner_user_id),
    NULL,
    COALESCE(l.stage_entered_at, l.created_at),
    NULL,
    jsonb_build_object('kind', 'backfill')
FROM leads l
WHERE l.pipeline_id IS NOT NULL
  AND l.stage_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM lead_stage_transitions t WHERE t.lead_id = l.id
  );
