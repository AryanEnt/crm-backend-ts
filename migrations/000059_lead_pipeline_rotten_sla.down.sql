-- Clear rotting SLAs on Leads Pipeline open stages.

UPDATE pipeline_stages
SET sla_hours = NULL, updated_at = NOW()
WHERE id IN (
    '66666666-6666-6666-6666-666666666801',
    '66666666-6666-6666-6666-666666666802',
    '66666666-6666-6666-6666-666666666805'
  )
  AND pipeline_id = '55555555-5555-5555-5555-555555555504';
