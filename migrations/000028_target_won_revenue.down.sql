DELETE FROM targets WHERE metric = 'won_revenue';
ALTER TABLE targets DROP CONSTRAINT IF EXISTS targets_metric_check;
ALTER TABLE targets ADD CONSTRAINT targets_metric_check CHECK (metric IN (
    'leads',
    'qualified_leads',
    'submissions',
    'positive_outcomes',
    'conversions',
    'pipeline_value',
    'activities'
));
