-- "Won" / "Lost" on a deal move it to its pipeline's won / lost stage. Stages could not be
-- flagged from the admin UI, so sales pipelines ended up with a "Closed Lost" column the
-- Lost button never targets, or with no lost stage at all.

-- Flag an existing "Closed Lost" / "Closed Won" style stage where the pipeline has none.
UPDATE pipeline_stages s
SET is_lost = TRUE, is_active = TRUE
FROM (
    SELECT DISTINCT ON (ps.pipeline_id) ps.id
    FROM pipeline_stages ps
    JOIN pipelines p ON p.id = ps.pipeline_id AND p.kind = 'sales'
    WHERE NOT ps.is_won
      AND lower(ps.name) ~ '^\s*(closed\W*)?lost\s*$'
      AND NOT EXISTS (
          SELECT 1 FROM pipeline_stages o
          WHERE o.pipeline_id = ps.pipeline_id AND o.is_lost AND o.is_active
      )
    ORDER BY ps.pipeline_id, ps.is_active DESC, ps.position
) pick
WHERE s.id = pick.id;

UPDATE pipeline_stages s
SET is_won = TRUE, is_active = TRUE
FROM (
    SELECT DISTINCT ON (ps.pipeline_id) ps.id
    FROM pipeline_stages ps
    JOIN pipelines p ON p.id = ps.pipeline_id AND p.kind = 'sales'
    WHERE NOT ps.is_lost
      AND lower(ps.name) ~ '^\s*(closed\W*)?won\s*$'
      AND NOT EXISTS (
          SELECT 1 FROM pipeline_stages o
          WHERE o.pipeline_id = ps.pipeline_id AND o.is_won AND o.is_active
      )
    ORDER BY ps.pipeline_id, ps.is_active DESC, ps.position
) pick
WHERE s.id = pick.id;

-- Every sales pipeline gets a lost stage so "Lost" always has somewhere to file the deal.
INSERT INTO pipeline_stages (pipeline_id, name, position, probability, visual_accent, is_won, is_lost, is_active)
SELECT p.id, 'Closed Lost', COALESCE(MAX(s.position), 0) + 1, 0, 'rose', FALSE, TRUE, TRUE
FROM pipelines p
LEFT JOIN pipeline_stages s ON s.pipeline_id = p.id
WHERE p.kind = 'sales'
  AND NOT EXISTS (
      SELECT 1 FROM pipeline_stages l
      WHERE l.pipeline_id = p.id AND l.is_lost AND l.is_active
  )
GROUP BY p.id
ON CONFLICT (pipeline_id, name) DO NOTHING;

-- Deals already sitting in an outcome stage take that outcome.
UPDATE deals d
SET status = CASE WHEN s.is_won THEN 'won' ELSE 'lost' END
FROM pipeline_stages s
WHERE d.stage_id = s.id
  AND d.status = 'open'
  AND (s.is_won OR s.is_lost);
