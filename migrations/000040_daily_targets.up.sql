-- Targets can be set for a single day, not only a month or quarter.
ALTER TABLE targets DROP CONSTRAINT IF EXISTS targets_period_type_check;
ALTER TABLE targets ADD CONSTRAINT targets_period_type_check CHECK (period_type IN (
    'daily',
    'monthly',
    'quarterly'
));
