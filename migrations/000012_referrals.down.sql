DROP TABLE IF EXISTS referrals;
DROP TABLE IF EXISTS referral_partners;
DROP TABLE IF EXISTS referral_statuses;
DROP TABLE IF EXISTS referral_relationships;
DROP TABLE IF EXISTS referral_referrer_types;

DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions WHERE code LIKE 'referrals:%'
);
DELETE FROM permissions WHERE code LIKE 'referrals:%';
