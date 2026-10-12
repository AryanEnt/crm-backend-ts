DROP INDEX IF EXISTS deals_expected_close_idx;
DROP INDEX IF EXISTS deals_status_closed_at_idx;
DROP TRIGGER IF EXISTS targets_set_updated_at ON targets;
DROP TABLE IF EXISTS targets;
