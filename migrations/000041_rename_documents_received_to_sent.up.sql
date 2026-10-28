-- Nurturing middle stage: chase "sent" not "received".

UPDATE pipeline_stages
SET name = 'Documents Sent'
WHERE id = '66666666-6666-6666-6666-666666666902'
  AND name = 'Documents Received';
