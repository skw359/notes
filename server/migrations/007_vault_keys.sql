-- CRYPTO-1 / CRYPTO-5: key identifiers, rotation and envelope-version floor.
--   vault_key_id         fingerprint of the current vault key (computed by the
--                        client from the key; NULL until first reported)
--   vault_keyring        previous vault keys wrapped by the current key while
--                        a rotation re-encrypts old data: {keyId: envelope}
--   rotation_started_at  set while a rotation or format upgrade is running
--   min_envelope_version raised to 3 once every record is v3, after which
--                        clients refuse unauthenticated-context (v1/v2) data
ALTER TABLE users ADD COLUMN vault_key_id TEXT;
ALTER TABLE users ADD COLUMN vault_keyring JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN rotation_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN min_envelope_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN recovery_key_updated_at TIMESTAMPTZ;
