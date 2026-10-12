-- Foundation migration: extensions and shared helpers only.
-- Domain tables are introduced in later phases once models are designed.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Shared trigger function for updated_at timestamps.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
