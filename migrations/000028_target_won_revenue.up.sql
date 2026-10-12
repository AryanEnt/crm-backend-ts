-- Targets can track the value of won deals.
ALTER TABLE targets DROP CONSTRAINT IF EXISTS targets_metric_check;
ALTER TABLE targets ADD CONSTRAINT targets_metric_check CHECK (metric IN (
    'leads',
    'qualified_leads',
    'submissions',
    'positive_outcomes',
    'conversions',
    'pipeline_value',
    'activities',
    'won_revenue'
));
