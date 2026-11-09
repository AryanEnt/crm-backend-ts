ALTER TABLE email_templates
    ADD COLUMN IF NOT EXISTS signature_html TEXT NOT NULL DEFAULT '';
