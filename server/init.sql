CREATE DATABASE notes_app;

\c notes_app;

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  password_hash VARCHAR(255),
  profile_picture VARCHAR(255) DEFAULT NULL,
  auth_mode VARCHAR(20) NOT NULL DEFAULT 'legacy',
  auth_salt TEXT,
  kdf_params JSONB,
  auth_verifier_hash VARCHAR(255),
  recovery_verifier_hash VARCHAR(255),
  wrapped_vault_key JSONB,
  wrapped_vault_key_recovery JSONB,
  encrypted_profile JSONB,
  vault_version INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content JSONB DEFAULT NULL,
  encrypted_content JSONB DEFAULT NULL,
  encrypted_summary JSONB DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE blobs (
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
