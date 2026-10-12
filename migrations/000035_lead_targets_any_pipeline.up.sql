-- Lead targets filtered to a deals pipeline never count anything, because leads live in lead
-- pipelines. Such targets now count every lead pipeline instead.
UPDATE targets t
SET pipeline_id = NULL
FROM pipelines p
WHERE p.id = t.pipeline_id
  AND p.kind <> 'leads'
  AND t.metric IN ('leads', 'qualified_leads', 'conversions', 'leads_won', 'won_lead_value',
                   'proposal_entries', 'open_lead_value');
