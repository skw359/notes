-- DATA-5: the legacy -> end-to-end encryption migration uploads encrypted
-- notes in batches first; the final switch then applies them atomically.
-- Large accounts make visible progress and an interrupted upload resumes.
CREATE TABLE migration_staging (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_revision BIGINT NOT NULL,
  encrypted_content JSONB NOT NULL,
  encrypted_summary JSONB NOT NULL,
  blob_ids INTEGER[] NOT NULL DEFAULT '{}',
  staged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX migration_staging_user_idx ON migration_staging (user_id);
