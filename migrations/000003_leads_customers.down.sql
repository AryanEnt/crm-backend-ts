DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS deals;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_converted_from_lead_fk;
DROP TABLE IF EXISTS leads;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS pipeline_stages;
DROP TABLE IF EXISTS pipelines;
DROP TABLE IF EXISTS anzsco_occupations;
