-- Second lead pipeline: after Sales Won, leads hand off here for document follow-up.
-- Lead Pipeline stays the default for new leads.

INSERT INTO pipelines (id, name, kind, is_default, is_active, description)
VALUES (
    '55555555-5555-5555-5555-555555555505',
    'Nurturing',
    'leads',
    FALSE,
    TRUE,
    'Post-win document collection and follow-up. Leads arrive here automatically after Won.'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO pipeline_stages (
    id, pipeline_id, name, position, probability, visual_accent,
    required_fields, required_activities, required_documents, sla_hours, is_won, is_lost, is_active
)
SELECT v.id::uuid, '55555555-5555-5555-5555-555555555505'::uuid, v.name, v.position, v.probability, v.accent,
       '{}'::text[], '{}'::text[], '{}'::text[], v.sla, v.is_won, FALSE, TRUE
FROM (VALUES
    ('66666666-6666-6666-6666-666666666901', 'Documents Pending', 1,  40, 'amber',  168, FALSE),
    ('66666666-6666-6666-6666-666666666902', 'Documents Sent', 2,  70, 'teal',   72, FALSE),
    ('66666666-6666-6666-6666-666666666903', 'Complete',           3, 100, 'green', NULL, TRUE)
) AS v(id, name, position, probability, accent, sla, is_won)
WHERE EXISTS (SELECT 1 FROM pipelines WHERE id = '55555555-5555-5555-5555-555555555505')
ON CONFLICT (id) DO NOTHING;
