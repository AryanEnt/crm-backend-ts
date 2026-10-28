-- Targets can count calls or meetings on their own, not only every activity.
ALTER TABLE targets DROP CONSTRAINT IF EXISTS targets_metric_check;
ALTER TABLE targets ADD CONSTRAINT targets_metric_check CHECK (metric IN (
    'leads',
    'qualified_leads',
    'submissions',
    'positive_outcomes',
    'conversions',
    'pipeline_value',
    'activities',
    'activities_calls',
    'activities_meetings',
    'won_revenue',
    'leads_won',
    'won_lead_value',
    'proposal_entries',
    'open_lead_value'
));
