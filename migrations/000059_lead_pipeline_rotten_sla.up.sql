-- Lead Pipeline rotting limits (hours): Leads 1d, Contacted 2d, Negotiation 5d.
-- Purchased / Lost keep NULL SLA (no rotting on closed stages).

UPDATE pipeline_stages
SET sla_hours = 24, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666801'
  AND pipeline_id = '55555555-5555-5555-5555-555555555504';

UPDATE pipeline_stages
SET sla_hours = 48, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666802'
  AND pipeline_id = '55555555-5555-5555-5555-555555555504';

UPDATE pipeline_stages
SET sla_hours = 120, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666805'
  AND pipeline_id = '55555555-5555-5555-5555-555555555504';
