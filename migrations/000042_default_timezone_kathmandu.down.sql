ALTER TABLE users ALTER COLUMN timezone SET DEFAULT 'UTC';
UPDATE users SET timezone = 'UTC' WHERE timezone = 'Asia/Kathmandu';

UPDATE organization_settings
SET value = 'Australia/Sydney', updated_at = NOW()
WHERE key = 'organization.timezone' AND value = 'Asia/Kathmandu';
