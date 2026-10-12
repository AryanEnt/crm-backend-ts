DROP INDEX IF EXISTS custom_fields_pipeline_idx;
DROP INDEX IF EXISTS custom_fields_scope_key;
ALTER TABLE custom_fields DROP COLUMN IF EXISTS stage_id;
ALTER TABLE custom_fields DROP COLUMN IF EXISTS pipeline_id;
ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_entity_internal_key_key UNIQUE (entity, internal_key);
