-- One lead pipeline. Leads in the old Lead Qualification pipeline (or in none) join the Lead
-- Pipeline, whose first stage becomes "Cold lead". Lead Qualification is deactivated rather than
-- deleted so stage history and its custom fields survive. Nothing runs if the Lead Pipeline is gone.

UPDATE pipeline_stages SET name = 'Cold lead'
WHERE id = '66666666-6666-6666-6666-666666666801'
  AND name = 'Created'
  AND NOT EXISTS (
      SELECT 1 FROM pipeline_stages
      WHERE pipeline_id = '55555555-5555-5555-5555-555555555504' AND name = 'Cold lead'
  );

WITH moved AS (
    SELECT l.id,
           l.pipeline_id AS from_pipeline_id,
           l.stage_id AS from_stage_id,
           l.stage_entered_at AS from_entered_at,
           (CASE
               WHEN l.status IN ('won', 'converted') OR os.is_won THEN '66666666-6666-6666-6666-666666666806'
               WHEN l.status IN ('lost', 'unqualified') OR os.is_lost THEN '66666666-6666-6666-6666-666666666807'
               WHEN os.id = '66666666-6666-6666-6666-666666666603' OR l.status = 'qualified' THEN '66666666-6666-6666-6666-666666666803'
               WHEN os.id = '66666666-6666-6666-6666-666666666602' THEN '66666666-6666-6666-6666-666666666802'
               ELSE '66666666-6666-6666-6666-666666666801'
           END)::uuid AS to_stage_id
    FROM leads l
    LEFT JOIN pipeline_stages os ON os.id = l.stage_id
    WHERE (l.pipeline_id = '55555555-5555-5555-5555-555555555501' OR l.pipeline_id IS NULL)
      AND (SELECT COUNT(*) FROM pipeline_stages
           WHERE pipeline_id = '55555555-5555-5555-5555-555555555504'
             AND id IN ('66666666-6666-6666-6666-666666666801', '66666666-6666-6666-6666-666666666802',
                        '66666666-6666-6666-6666-666666666803', '66666666-6666-6666-6666-666666666806',
                        '66666666-6666-6666-6666-666666666807')) = 5
),
updated AS (
    UPDATE leads l SET
        pipeline_id = '55555555-5555-5555-5555-555555555504',
        stage_id = m.to_stage_id,
        -- Converted leads sit in Won but keep their status, which conversion reports count.
        status = CASE
            WHEN l.is_archived OR l.status IN ('converted', 'archived') THEN l.status
            WHEN m.to_stage_id = '66666666-6666-6666-6666-666666666806' THEN 'won'
            WHEN m.to_stage_id = '66666666-6666-6666-6666-666666666807' THEN 'lost'
            ELSE 'open'
        END,
        won_at = CASE WHEN m.to_stage_id = '66666666-6666-6666-6666-666666666806' AND l.status NOT IN ('converted', 'archived')
                      THEN COALESCE(l.won_at, l.updated_at) ELSE l.won_at END,
        lost_at = CASE WHEN m.to_stage_id = '66666666-6666-6666-6666-666666666807' AND l.status <> 'archived'
                       THEN COALESCE(l.lost_at, l.updated_at) ELSE l.lost_at END,
        lost_reason = CASE WHEN m.to_stage_id = '66666666-6666-6666-6666-666666666807' AND l.lost_reason = ''
                           THEN 'Unqualified' ELSE l.lost_reason END,
        stage_entered_at = NOW()
    FROM moved m
    WHERE l.id = m.id
    RETURNING l.id
)
INSERT INTO lead_stage_transitions (
    lead_id, from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id,
    from_stage_entered_at, duration_seconds, metadata
)
SELECT m.id, m.from_pipeline_id, m.from_stage_id, '55555555-5555-5555-5555-555555555504', m.to_stage_id,
       m.from_entered_at,
       CASE WHEN m.from_entered_at IS NULL THEN NULL
            ELSE GREATEST(0, EXTRACT(EPOCH FROM (NOW() - m.from_entered_at)))::int END,
       '{"source": "migration", "reason": "single lead pipeline"}'::jsonb
FROM moved m
JOIN updated u ON u.id = m.id;

UPDATE targets SET pipeline_id = '55555555-5555-5555-5555-555555555504'
WHERE pipeline_id = '55555555-5555-5555-5555-555555555501'
  AND EXISTS (SELECT 1 FROM pipelines WHERE id = '55555555-5555-5555-5555-555555555504');

WITH remap AS (
    SELECT cf.id,
           (CASE cf.stage_id
               WHEN '66666666-6666-6666-6666-666666666601' THEN '66666666-6666-6666-6666-666666666801'
               WHEN '66666666-6666-6666-6666-666666666602' THEN '66666666-6666-6666-6666-666666666802'
               WHEN '66666666-6666-6666-6666-666666666603' THEN '66666666-6666-6666-6666-666666666803'
               WHEN '66666666-6666-6666-6666-666666666604' THEN '66666666-6666-6666-6666-666666666807'
           END)::uuid AS new_stage_id
    FROM custom_fields cf
    WHERE cf.pipeline_id = '55555555-5555-5555-5555-555555555501'
      AND (cf.stage_id IS NULL OR cf.stage_id IN (
          '66666666-6666-6666-6666-666666666601', '66666666-6666-6666-6666-666666666602',
          '66666666-6666-6666-6666-666666666603', '66666666-6666-6666-6666-666666666604'))
      AND EXISTS (SELECT 1 FROM pipeline_stages WHERE id = '66666666-6666-6666-6666-666666666801')
)
UPDATE custom_fields cf
SET pipeline_id = '55555555-5555-5555-5555-555555555504', stage_id = r.new_stage_id
FROM remap r
WHERE cf.id = r.id
  AND NOT EXISTS (
      SELECT 1 FROM custom_fields other
      WHERE other.entity = cf.entity
        AND other.internal_key = cf.internal_key
        AND other.pipeline_id = '55555555-5555-5555-5555-555555555504'
        AND other.stage_id IS NOT DISTINCT FROM r.new_stage_id
  );

UPDATE pipelines SET is_default = (id = '55555555-5555-5555-5555-555555555504')
WHERE kind = 'leads'
  AND EXISTS (SELECT 1 FROM pipeline_stages WHERE id = '66666666-6666-6666-6666-666666666801');

UPDATE pipeline_stages SET is_active = FALSE
WHERE pipeline_id = '55555555-5555-5555-5555-555555555501'
  AND NOT EXISTS (SELECT 1 FROM leads WHERE pipeline_id = '55555555-5555-5555-5555-555555555501');

UPDATE pipelines SET is_active = FALSE, is_default = FALSE
WHERE id = '55555555-5555-5555-5555-555555555501'
  AND NOT EXISTS (SELECT 1 FROM leads WHERE pipeline_id = '55555555-5555-5555-5555-555555555501');
