UPDATE referral_referrer_types
SET is_active = TRUE, updated_at = NOW()
WHERE code = 'sales_executive';
