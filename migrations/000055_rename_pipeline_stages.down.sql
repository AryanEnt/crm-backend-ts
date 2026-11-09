-- Reverse 000055 stage renames. Does not recreate leads that were moved off Qualified/Proposal.

UPDATE pipelines SET name = 'Lead Pipeline'
WHERE id = '55555555-5555-5555-5555-555555555504' AND name = 'Leads Pipeline';

UPDATE pipelines
SET description = 'Post-win document collection and follow-up. Leads arrive here automatically after Won.'
WHERE id = '55555555-5555-5555-5555-555555555505';

UPDATE pipeline_stages SET name = 'Lead',        position = 1, probability = 10,  updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666801';

UPDATE pipeline_stages SET name = 'Contacted',   position = 2, probability = 20,  is_active = TRUE, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666802';

UPDATE pipeline_stages SET name = 'Qualified',   position = 3, probability = 40,  is_active = TRUE, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666803';

UPDATE pipeline_stages SET name = 'Proposal',    position = 4, probability = 60,  is_active = TRUE, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666804';

UPDATE pipeline_stages SET name = 'Negotiation', position = 5, probability = 80,  updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666805';

UPDATE pipeline_stages SET name = 'Won',         position = 6, probability = 100, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666806';

UPDATE pipeline_stages SET name = 'Lost',        position = 7, probability = 0,   updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666807';

UPDATE pipeline_stages SET name = 'Documents Pending', updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666901';

UPDATE pipeline_stages SET name = 'Documents Sent',    updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666902';

UPDATE pipeline_stages SET name = 'Complete',          updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666903';
