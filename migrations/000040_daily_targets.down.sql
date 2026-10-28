DELETE FROM targets WHERE period_type = 'daily';
ALTER TABLE targets DROP CONSTRAINT IF EXISTS targets_period_type_check;
ALTER TABLE targets ADD CONSTRAINT targets_period_type_check CHECK (period_type IN (
    'monthly',
    'quarterly'
));
