DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code IN ('predictions:view', 'predictions:manage'));
DELETE FROM permissions WHERE code IN ('predictions:view', 'predictions:manage');

DROP INDEX IF EXISTS prediction_results_strategy_idx;
DROP INDEX IF EXISTS prediction_results_insight_idx;
DROP INDEX IF EXISTS prediction_results_entity_idx;
DROP TABLE IF EXISTS prediction_results;

DROP INDEX IF EXISTS lead_score_snapshots_strategy_idx;
DROP INDEX IF EXISTS lead_score_snapshots_lead_computed_idx;
DROP TABLE IF EXISTS lead_score_snapshots;
