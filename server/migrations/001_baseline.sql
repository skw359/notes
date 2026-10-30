-- Baseline: the 1.x schema (init.sql + the ALTERs schema.js ran on every boot).
-- Written idempotently so fresh databases, init.sql databases and databases
-- upgraded by schema.js all converge on the same starting point.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  password_hash VARCHAR(255),
  profile_picture VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_mode VARCHAR(20) DEFAULT 'legacy';
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_salt TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kdf_params JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_verifier_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_verifier_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wrapped_vault_key JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wrapped_vault_key_recovery JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS encrypted_profile JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_version INTEGER DEFAULT 1;
ALTER TABLE users ALTER COLUMN first_name DROP NOT NULL;
ALTER TABLE users ALTER COLUMN last_name DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
UPDATE users SET auth_mode = 'legacy' WHERE auth_mode IS NULL;

CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content JSONB DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE notes ADD COLUMN IF NOT EXISTS encrypted_content JSONB;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS encrypted_summary JSONB;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS blobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(64) NOT NULL,
  mime_type VARCHAR(255),
  byte_length INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  envelope_iv TEXT NOT NULL,
  envelope_algorithm VARCHAR(64) NOT NULL DEFAULT 'AES-256-GCM',
  envelope_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS blobs_user_id_idx ON blobs(user_id);
