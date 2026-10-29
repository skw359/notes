import pool from './db.js';

const SCHEMA_STATEMENTS = [
  `
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auth_mode VARCHAR(20) DEFAULT 'legacy'
  `,
  `
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auth_salt TEXT
  `,
  `
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS kdf_params JSONB
  `,
  `
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auth_verifier_hash VARCHAR(255)
  `,
  `
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS recovery_verifier_hash VARCHAR(255)
  `,
  `
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS wrapped_vault_key JSONB
  `,
  `
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS wrapped_vault_key_recovery JSONB
  `,
  `
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS encrypted_profile JSONB
  `,
  `
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS vault_version INTEGER DEFAULT 1
  `,
  `
    ALTER TABLE users
    ALTER COLUMN first_name DROP NOT NULL
  `,
  `
    ALTER TABLE users
    ALTER COLUMN last_name DROP NOT NULL
  `,
  `
    ALTER TABLE users
    ALTER COLUMN password_hash DROP NOT NULL
  `,
  `
    ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS encrypted_content JSONB
  `,
  `
    ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS encrypted_summary JSONB
  `,
  `
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
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS blobs_user_id_idx
    ON blobs(user_id)
  `,
  `
    ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP
  `,
];

export async function ensureSchema() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const statement of SCHEMA_STATEMENTS) {
      await client.query(statement);
    }

    await client.query(
      `
        UPDATE users
        SET auth_mode = 'legacy'
        WHERE auth_mode IS NULL
      `
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
