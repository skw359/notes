-- Blob lifecycle (DATA-4, SEC-7, OPS-2).

-- OPS-2: blobs are located by a key relative to STORAGE_DIR. storage_path
-- keeps the old absolute value only so pre-2.0 code still works after a
-- rollback; 2.x never reads it. Windows and POSIX separators are both handled.
ALTER TABLE blobs ADD COLUMN storage_key TEXT;
UPDATE blobs SET storage_key = NULLIF(regexp_replace(storage_path, '^.*[\\/]', ''), '');

-- v3 (chunked) blobs carry their IVs inline.
ALTER TABLE blobs ALTER COLUMN envelope_iv DROP NOT NULL;
ALTER TABLE blobs ADD COLUMN key_id TEXT;
-- Set while no note, revision or profile references the blob; the garbage
-- collector deletes it once this is older than the grace period.
ALTER TABLE blobs ADD COLUMN unreferenced_since TIMESTAMPTZ;
-- Set when a key rotation uploads a re-encrypted copy.
ALTER TABLE blobs ADD COLUMN replaced_by INTEGER;
CREATE INDEX blobs_unreferenced_idx ON blobs (unreferenced_since) WHERE unreferenced_since IS NOT NULL;

-- Which blobs each note's current version references (reported by clients on
-- every save; blob ids are opaque and already tied to the user).
CREATE TABLE blob_refs (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  blob_id INTEGER NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, blob_id)
);
CREATE INDEX blob_refs_blob_idx ON blob_refs (blob_id);

-- Garbage collection only runs for a user once every note, revision and the
-- profile has known references. Existing encrypted notes start unknown and
-- are reconciled by the client; legacy notes never reference blobs.
ALTER TABLE notes ADD COLUMN blob_refs_known BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notes DISABLE TRIGGER notes_before_write;
UPDATE notes n SET blob_refs_known = TRUE
FROM users u
WHERE u.id = n.user_id AND u.auth_mode = 'legacy';
ALTER TABLE notes ENABLE TRIGGER notes_before_write;

-- Not a foreign key: a cascade cycle through users -> blobs -> users would
-- make account deletion fail. Ownership is checked on write.
ALTER TABLE users ADD COLUMN profile_blob_id INTEGER;
ALTER TABLE users ADD COLUMN profile_ref_known BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET profile_ref_known = TRUE WHERE auth_mode = 'legacy';
