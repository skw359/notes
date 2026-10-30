-- Server-side sessions (SEC-4): revocable, sliding expiry, listed per device.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                        -- hex SHA-256 of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  origin TEXT NOT NULL,                        -- login, signup, recover, migrate, legacy-jwt
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Pre-2.0 JWT cookies issued before this instant are refused (bumped by
-- "sign out everywhere", password changes and recovery).
ALTER TABLE users ADD COLUMN sessions_revoked_before TIMESTAMPTZ;

-- Instance-level secrets generated on first boot (e.g. the verifier pepper).
CREATE TABLE server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
