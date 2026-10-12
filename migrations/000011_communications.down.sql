DROP INDEX IF EXISTS timeline_events_external_unique;
DROP TABLE IF EXISTS webhook_receipts;
DROP TRIGGER IF EXISTS twilio_calls_set_updated_at ON twilio_calls;
DROP TABLE IF EXISTS twilio_calls;
DROP TRIGGER IF EXISTS whatsapp_messages_set_updated_at ON whatsapp_messages;
DROP TABLE IF EXISTS whatsapp_messages;
DROP TRIGGER IF EXISTS communication_accounts_set_updated_at ON communication_accounts;
DROP TABLE IF EXISTS communication_accounts;
DELETE FROM permissions WHERE code IN (
    'communications:view', 'communications:send', 'communications:manage'
);
