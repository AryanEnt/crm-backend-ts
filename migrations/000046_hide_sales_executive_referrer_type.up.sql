-- Hide Sales Executive from Referrer type pickers (Existing Customer remains).
UPDATE referral_referrer_types
SET is_active = FALSE, updated_at = NOW()
WHERE code = 'sales_executive';
