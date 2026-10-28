-- Default Calendar / activity timezone to Asia/Kathmandu
ALTER TABLE users ALTER COLUMN timezone SET DEFAULT 'Asia/Kathmandu';
UPDATE users SET timezone = 'Asia/Kathmandu' WHERE timezone IS NULL OR timezone = '' OR timezone = 'UTC';

UPDATE organization_settings
SET value = 'Asia/Kathmandu', updated_at = NOW()
WHERE key = 'organization.timezone'
  AND (value IS NULL OR value IN ('', 'UTC', 'Australia/Sydney'));
