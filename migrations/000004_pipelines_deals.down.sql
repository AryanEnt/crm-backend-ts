-- Rollback pipeline/deal enrichment

DROP TABLE IF EXISTS automation_events;
DROP TABLE IF EXISTS deal_stage_transitions;

ALTER TABLE documents DROP COLUMN IF EXISTS category;

ALTER TABLE deals
    DROP COLUMN IF EXISTS probability,
    DROP COLUMN IF EXISTS source,
    DROP COLUMN IF EXISTS priority,
    DROP COLUMN IF EXISTS last_activity_at,
    DROP COLUMN IF EXISTS next_activity_at,
    DROP COLUMN IF EXISTS stage_entered_at,
    DROP COLUMN IF EXISTS field_values;

DELETE FROM pipeline_stages WHERE pipeline_id = '55555555-5555-5555-5555-555555555503';
DELETE FROM pipelines WHERE id = '55555555-5555-5555-5555-555555555503';

ALTER TABLE pipeline_stages
    DROP COLUMN IF EXISTS probability,
    DROP COLUMN IF EXISTS visual_accent,
    DROP COLUMN IF EXISTS required_fields,
    DROP COLUMN IF EXISTS required_activities,
    DROP COLUMN IF EXISTS required_documents,
    DROP COLUMN IF EXISTS sla_hours,
    DROP COLUMN IF EXISTS is_active;

ALTER TABLE pipelines DROP COLUMN IF EXISTS description;
