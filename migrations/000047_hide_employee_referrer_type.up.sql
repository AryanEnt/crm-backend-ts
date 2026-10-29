-- Hide Employee from Referrer type pickers (Existing Customer / Partner remain).
UPDATE referral_referrer_types
SET is_active = FALSE, updated_at = NOW()
WHERE code = 'employee';
