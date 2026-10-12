-- Repair accidental multi-team memberships for Sales Executives / Team Leads.
-- Keep the oldest membership per user; drop the rest. One team at a time.

WITH ranked AS (
    SELECT tm.ctid,
           ROW_NUMBER() OVER (
               PARTITION BY tm.user_id
               ORDER BY tm.team_id
           ) AS rn
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    JOIN roles r ON r.id = u.role_id
    WHERE r.code IN ('sales_executive', 'sales_manager')
)
DELETE FROM team_members tm
USING ranked
WHERE tm.ctid = ranked.ctid
  AND ranked.rn > 1;
