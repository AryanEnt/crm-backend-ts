-- Team-aware document sharing for Admin / Team Lead library docs.
-- Access is resolved against current team_members (membership moves revoke prior team access).

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS share_scope TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS original_filename TEXT NOT NULL DEFAULT '';

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_share_scope_chk;

ALTER TABLE documents
  ADD CONSTRAINT documents_share_scope_chk CHECK (
    share_scope IN ('all_teams', 'selected_teams', 'all_team_ses', 'selected_ses', 'none')
  );

CREATE TABLE IF NOT EXISTS document_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,
    team_id UUID REFERENCES teams (id) ON DELETE CASCADE,
    user_id UUID REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT document_shares_target_type_chk CHECK (target_type IN ('team', 'user')),
    CONSTRAINT document_shares_target_chk CHECK (
        (target_type = 'team' AND team_id IS NOT NULL AND user_id IS NULL)
        OR (target_type = 'user' AND user_id IS NOT NULL AND team_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS document_shares_document_team_uidx
  ON document_shares (document_id, team_id)
  WHERE team_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS document_shares_document_user_uidx
  ON document_shares (document_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS document_shares_team_id_idx ON document_shares (team_id);
CREATE INDEX IF NOT EXISTS document_shares_user_id_idx ON document_shares (user_id);
CREATE INDEX IF NOT EXISTS document_shares_document_id_idx ON document_shares (document_id);

-- Migrate legacy per-user viewers into selected_ses shares.
INSERT INTO document_shares (document_id, target_type, user_id)
SELECT dv.document_id, 'user', dv.user_id
FROM document_viewers dv
ON CONFLICT DO NOTHING;

UPDATE documents d
SET share_scope = 'selected_ses'
WHERE d.share_scope = 'none'
  AND EXISTS (SELECT 1 FROM document_viewers dv WHERE dv.document_id = d.id);

-- Super Admin may upload/share library documents.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT '11111111-1111-1111-1111-111111111111', p.id, 'organization'
FROM permissions p
WHERE p.code = 'documents:create'
ON CONFLICT (role_id, permission_id) DO UPDATE SET scope = EXCLUDED.scope;
