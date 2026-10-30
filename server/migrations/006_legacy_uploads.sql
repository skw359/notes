-- SEC-1: explicit ownership of pre-encryption upload files. Ownership used to
-- be inferred from user-controlled note text. Rows are backfilled at startup
-- from trusted filename prefixes (see lib/legacyUploads.js).
CREATE TABLE legacy_uploads (
  filename TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  byte_length BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  migrated_blob_id INTEGER,
  migrated_at TIMESTAMPTZ,
  quarantined_at TIMESTAMPTZ
);
CREATE INDEX legacy_uploads_user_idx ON legacy_uploads (user_id);
