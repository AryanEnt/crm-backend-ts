DROP TRIGGER IF EXISTS email_templates_set_updated_at ON email_templates;
DROP TRIGGER IF EXISTS email_messages_set_updated_at ON email_messages;
DROP TRIGGER IF EXISTS email_threads_set_updated_at ON email_threads;
DROP TRIGGER IF EXISTS email_accounts_set_updated_at ON email_accounts;

DELETE FROM role_permissions WHERE permission_id IN (
    SELECT id FROM permissions WHERE resource = 'email'
);
DELETE FROM permissions WHERE resource = 'email';

DROP TABLE IF EXISTS email_attachments;
DROP TABLE IF EXISTS email_messages;
DROP TABLE IF EXISTS email_threads;
DROP TABLE IF EXISTS email_oauth_states;
DROP TABLE IF EXISTS email_templates;
DROP TABLE IF EXISTS email_accounts;
