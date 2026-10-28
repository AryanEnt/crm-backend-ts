-- Completing an activity used to leave leads.next_activity_at on the old due date.
-- Recompute from open activities (NULL when none remain).

UPDATE leads l
SET next_activity_at = (
    SELECT MIN(COALESCE(a.due_at, a.start_at))
    FROM activities a
    WHERE a.lead_id = l.id
      AND a.status IN ('upcoming', 'due', 'overdue')
)
WHERE l.next_activity_at IS NOT NULL
  AND l.next_activity_at IS DISTINCT FROM (
      SELECT MIN(COALESCE(a.due_at, a.start_at))
      FROM activities a
      WHERE a.lead_id = l.id
        AND a.status IN ('upcoming', 'due', 'overdue')
  );

UPDATE deals d
SET next_activity_at = (
    SELECT MIN(COALESCE(a.due_at, a.start_at))
    FROM activities a
    WHERE a.deal_id = d.id
      AND a.status IN ('upcoming', 'due', 'overdue')
)
WHERE d.next_activity_at IS NOT NULL
  AND d.next_activity_at IS DISTINCT FROM (
      SELECT MIN(COALESCE(a.due_at, a.start_at))
      FROM activities a
      WHERE a.deal_id = d.id
        AND a.status IN ('upcoming', 'due', 'overdue')
  );

UPDATE customers c
SET next_follow_up_at = (
    SELECT MIN(COALESCE(a.due_at, a.start_at))
    FROM activities a
    WHERE a.customer_id = c.id
      AND a.status IN ('upcoming', 'due', 'overdue')
)
WHERE c.next_follow_up_at IS NOT NULL
  AND c.next_follow_up_at IS DISTINCT FROM (
      SELECT MIN(COALESCE(a.due_at, a.start_at))
      FROM activities a
      WHERE a.customer_id = c.id
        AND a.status IN ('upcoming', 'due', 'overdue')
  );
