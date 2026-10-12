-- Contacts each user pins to the top of the Calls list.
CREATE TABLE IF NOT EXISTS call_pins (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('lead', 'customer')),
    entity_id   UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, entity_type, entity_id)
);
