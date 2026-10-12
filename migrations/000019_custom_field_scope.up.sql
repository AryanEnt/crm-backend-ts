ALTER TABLE custom_fields
    ADD COLUMN pipeline_id UUID REFERENCES pipelines(id) ON DELETE CASCADE,
    ADD COLUMN stage_id UUID REFERENCES pipeline_stages(id) ON DELETE CASCADE;

ALTER TABLE custom_fields DROP CONSTRAINT IF EXISTS custom_fields_entity_internal_key_key;

CREATE UNIQUE INDEX custom_fields_scope_key
    ON custom_fields (
        entity,
        internal_key,
        COALESCE(pipeline_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(stage_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );

CREATE INDEX custom_fields_pipeline_idx ON custom_fields (pipeline_id) WHERE pipeline_id IS NOT NULL;
