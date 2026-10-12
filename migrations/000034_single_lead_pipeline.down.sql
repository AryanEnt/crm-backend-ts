-- Reactivates Lead Qualification and names the first stage Created again. Leads stay where they are.

UPDATE pipelines SET is_active = TRUE WHERE id = '55555555-5555-5555-5555-555555555501';
UPDATE pipeline_stages SET is_active = TRUE WHERE pipeline_id = '55555555-5555-5555-5555-555555555501';

UPDATE pipeline_stages SET name = 'Created'
WHERE id = '66666666-6666-6666-6666-666666666801'
  AND name = 'Cold lead'
  AND NOT EXISTS (
      SELECT 1 FROM pipeline_stages
      WHERE pipeline_id = '55555555-5555-5555-5555-555555555504' AND name = 'Created'
  );
