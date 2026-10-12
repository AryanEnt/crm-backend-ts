DROP TABLE IF EXISTS system_activity_events;
DROP TABLE IF EXISTS organization_settings;
DROP TABLE IF EXISTS custom_field_values;
DROP TABLE IF EXISTS custom_field_options;
DROP TABLE IF EXISTS custom_fields;
DROP TABLE IF EXISTS lead_sources;

ALTER TABLE activity_types
    DROP COLUMN IF EXISTS requires_datetime,
    DROP COLUMN IF EXISTS requires_duration,
    DROP COLUMN IF EXISTS requires_outcome,
    DROP COLUMN IF EXISTS requires_notes;
