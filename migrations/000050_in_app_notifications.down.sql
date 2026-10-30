DROP TABLE IF EXISTS in_app_notifications;

DELETE FROM organization_settings
 WHERE key IN ('notifications.sla_notify_team_lead', 'notifications.sla_scan_minutes');
