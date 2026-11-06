-- Reshape Lead Pipeline to: Leads → Contacted → Negotiation → Purchased → Lost.
-- Reshape Nurturing to: Clients → File Delivered → Outcome.
-- Qualified → Contacted; Proposal → Negotiation. Keep stage ids / is_won / is_lost flags.

-- Pipeline display names
UPDATE pipelines
SET name = 'Leads Pipeline',
    description = 'Default lead sales pipeline: Leads → Contacted → Negotiation → Purchased or Lost.'
WHERE id = '55555555-5555-5555-5555-555555555504';

UPDATE pipelines
SET description = 'Post-purchase document collection and follow-up. Leads arrive here automatically after Purchased.'
WHERE id = '55555555-5555-5555-5555-555555555505';

-- Move leads (and customers) off stages we are retiring
UPDATE leads SET stage_id = '66666666-6666-6666-6666-666666666802', updated_at = NOW()
WHERE stage_id = '66666666-6666-6666-6666-666666666803';

UPDATE leads SET stage_id = '66666666-6666-6666-6666-666666666805', updated_at = NOW()
WHERE stage_id = '66666666-6666-6666-6666-666666666804';

UPDATE customers SET stage_id = '66666666-6666-6666-6666-666666666802', updated_at = NOW()
WHERE stage_id = '66666666-6666-6666-6666-666666666803';

UPDATE customers SET stage_id = '66666666-6666-6666-6666-666666666805', updated_at = NOW()
WHERE stage_id = '66666666-6666-6666-6666-666666666804';

-- Retire Qualified and Proposal (keep rows for history FKs)
UPDATE pipeline_stages
SET is_active = FALSE, updated_at = NOW()
WHERE id IN (
    '66666666-6666-6666-6666-666666666803',
    '66666666-6666-6666-6666-666666666804'
);

-- Lead / Leads Pipeline stage renames + order
UPDATE pipeline_stages SET name = 'Leads',      position = 1, probability = 10, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666801';

UPDATE pipeline_stages SET name = 'Contacted',  position = 2, probability = 30, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666802';

UPDATE pipeline_stages SET name = 'Negotiation', position = 3, probability = 70, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666805';

UPDATE pipeline_stages SET name = 'Purchased',  position = 4, probability = 100, updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666806';

UPDATE pipeline_stages SET name = 'Lost',       position = 5, probability = 0,   updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666807';

-- Nurturing renames (order unchanged)
UPDATE pipeline_stages SET name = 'Clients',        updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666901';

UPDATE pipeline_stages SET name = 'File Delivered', updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666902';

UPDATE pipeline_stages SET name = 'Outcome',        updated_at = NOW()
WHERE id = '66666666-6666-6666-6666-666666666903';
