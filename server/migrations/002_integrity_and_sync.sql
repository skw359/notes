-- Data-integrity constraints, revisions and sync sequence numbers.

-- Timestamps become timestamptz. Existing values were written in the server's
-- session time zone, which is exactly how the implicit cast interprets them.
ALTER TABLE users
  ALTER COLUMN created_at TYPE TIMESTAMPTZ,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ;
ALTER TABLE notes
  ALTER COLUMN created_at TYPE TIMESTAMPTZ,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ,
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ;
ALTER TABLE blobs
  ALTER COLUMN created_at TYPE TIMESTAMPTZ;

UPDATE users SET created_at = NOW() WHERE created_at IS NULL;
UPDATE users SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE notes SET created_at = NOW() WHERE created_at IS NULL;
UPDATE notes SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE blobs SET created_at = NOW() WHERE created_at IS NULL;
ALTER TABLE users ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE notes ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE blobs ALTER COLUMN created_at SET NOT NULL;

-- users.auth_mode: required and restricted to known modes.
UPDATE users SET auth_mode = 'legacy' WHERE auth_mode IS NULL;
ALTER TABLE users ALTER COLUMN auth_mode SET NOT NULL;
ALTER TABLE users ALTER COLUMN auth_mode DROP DEFAULT;
ALTER TABLE users ADD CONSTRAINT users_auth_mode_check
  CHECK (auth_mode IN ('legacy', 'e2ee')) NOT VALID;
DO $$
BEGIN
  ALTER TABLE users VALIDATE CONSTRAINT users_auth_mode_check;
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'users.auth_mode has unexpected values; users_auth_mode_check left NOT VALID';
END $$;

-- Case-insensitive email uniqueness. Existing case-variant duplicates cannot
-- be merged automatically, so they only downgrade the index to non-unique.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE WARNING 'users.email has case-insensitive duplicates; created a non-unique index on lower(email)';
    CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));
  END IF;
END $$;

-- Some 1.x databases defaulted content to '{}'; an omitted column must never
-- produce plaintext.
ALTER TABLE notes ALTER COLUMN content SET DEFAULT NULL;

-- Optimistic concurrency. Existing rows count as saved once (revision 1);
-- freshly created rows start at 0 ("pending") until their first save.
ALTER TABLE notes ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE notes ALTER COLUMN revision SET DEFAULT 0;
ALTER TABLE notes ADD COLUMN last_writer_session TEXT;
ALTER TABLE notes ADD COLUMN last_snapshot_at TIMESTAMPTZ;

-- Monotonic change counter for delta sync (notes and tombstones share it).
CREATE SEQUENCE notes_sync_seq AS BIGINT;
ALTER TABLE notes ADD COLUMN sync_seq BIGINT;
UPDATE notes SET sync_seq = nextval('notes_sync_seq');
ALTER TABLE notes ALTER COLUMN sync_seq SET DEFAULT nextval('notes_sync_seq');
ALTER TABLE notes ALTER COLUMN sync_seq SET NOT NULL;

CREATE TABLE deleted_notes (
  note_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sync_seq BIGINT NOT NULL DEFAULT nextval('notes_sync_seq'),
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX deleted_notes_user_seq_idx ON deleted_notes (user_id, sync_seq);

-- Every note has an owner. Ownerless rows (unreachable through the API) are
-- kept for an operator to inspect; they only downgrade this to a NOT VALID
-- check, which still covers new rows. Placed after the backfills above
-- because a NOT VALID check also applies to updated rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM notes WHERE user_id IS NULL) THEN
    RAISE WARNING 'notes has rows without user_id; added a NOT VALID check instead of NOT NULL';
    ALTER TABLE notes ADD CONSTRAINT notes_user_id_present CHECK (user_id IS NOT NULL) NOT VALID;
  ELSE
    ALTER TABLE notes ALTER COLUMN user_id SET NOT NULL;
  END IF;
END $$;

-- Write guard. For end-to-end encrypted owners it refuses new plaintext and
-- refuses to replace existing ciphertext with NULL, so a stale client, a race
-- with migration or an operator script fails loudly instead of corrupting
-- data. The KEY SHARE lock makes a write that raced the legacy->e2ee migration
-- wait for it and then see the committed mode. 7301 = LOCK_NAMESPACE.userNotes.
CREATE FUNCTION notes_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_mode TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(7301, NEW.user_id);
  SELECT auth_mode INTO owner_mode FROM users WHERE id = NEW.user_id FOR KEY SHARE;

  IF owner_mode = 'e2ee' THEN
    IF NEW.content IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content) THEN
      RAISE EXCEPTION 'plaintext note content is not allowed for end-to-end encrypted accounts'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'notes_e2ee_no_plaintext';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.encrypted_content IS NOT NULL AND NEW.encrypted_content IS NULL THEN
      RAISE EXCEPTION 'refusing to erase the encrypted content of a note'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'notes_keep_ciphertext';
    END IF;
  END IF;

  -- Only client-visible changes advance the sync position; bookkeeping
  -- columns (reference tracking, snapshot timestamps) do not.
  IF TG_OP = 'INSERT'
     OR (NEW.content, NEW.encrypted_content, NEW.encrypted_summary, NEW.revision, NEW.deleted_at, NEW.updated_at)
        IS DISTINCT FROM
        (OLD.content, OLD.encrypted_content, OLD.encrypted_summary, OLD.revision, OLD.deleted_at, OLD.updated_at)
  THEN
    NEW.sync_seq := nextval('notes_sync_seq');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notes_before_write
  BEFORE INSERT OR UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_before_write();

-- Tombstones let other devices learn about permanent deletions. Skipped when
-- the owner itself is being deleted (account deletion cascades).
CREATE FUNCTION notes_after_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
    PERFORM pg_advisory_xact_lock(7301, OLD.user_id);
    INSERT INTO deleted_notes (note_id, user_id)
    VALUES (OLD.id, OLD.user_id)
    ON CONFLICT (note_id) DO UPDATE
      SET sync_seq = nextval('notes_sync_seq'), deleted_at = NOW();
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER notes_after_delete
  AFTER DELETE ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_after_delete();

-- PERF-1: every per-user query was a sequential scan of the whole table.
CREATE INDEX notes_user_active_idx ON notes (user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX notes_user_trash_idx ON notes (user_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX notes_user_sync_idx ON notes (user_id, sync_seq);
CREATE INDEX notes_trash_purge_idx ON notes (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX notes_pending_idx ON notes (created_at) WHERE revision = 0;
