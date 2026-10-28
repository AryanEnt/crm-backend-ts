UPDATE pipeline_stages
SET name = 'Cold lead'
WHERE name = 'Lead'
  AND pipeline_id = '55555555-5555-5555-5555-555555555504'
  AND position = 1;
