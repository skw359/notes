-- Note history (DATA-1, DATA-3). Rows hold opaque ciphertext only.
--   snapshot: a previous saved version of the note (revision = that version)
--   conflict: a rejected write (stale/missing base revision, trashed note)
--             kept so no edit is ever silently discarded
CREATE TABLE note_revisions (
  id BIGSERIAL PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot', 'conflict')),
  reason TEXT NOT NULL,
  revision BIGINT NOT NULL,
  encrypted_content JSONB NOT NULL,
  encrypted_summary JSONB,
  blob_ids INTEGER[] NOT NULL DEFAULT '{}',
  blob_refs_known BOOLEAN NOT NULL DEFAULT FALSE,
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX note_revisions_note_idx ON note_revisions (note_id, created_at DESC);
CREATE INDEX note_revisions_user_idx ON note_revisions (user_id);
CREATE INDEX note_revisions_open_conflicts_idx ON note_revisions (note_id)
  WHERE kind = 'conflict' AND resolved_at IS NULL;
