-- Rename the default Lead Pipeline first stage from "Cold lead" to "Lead".

UPDATE pipeline_stages
SET name = 'Lead'
WHERE name = 'Cold lead';
