import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../db.js';
import { getMigrationStatus, runMigrations } from '../migrations/runner.js';
import { createTestDatabase } from './helpers/database.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const quiet = { info() {}, warn() {} };

// The schema a 1.x install created with the old init.sql (minus CREATE
// DATABASE), plus rows shaped like real 1.x data.
const LEGACY_SCHEMA = `
  CREATE TABLE users (
    id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, first_name VARCHAR(100), last_name VARCHAR(100),
    password_hash VARCHAR(255), profile_picture VARCHAR(255) DEFAULT NULL, auth_mode VARCHAR(20) NOT NULL DEFAULT 'legacy',
    auth_salt TEXT, kdf_params JSONB, auth_verifier_hash VARCHAR(255), recovery_verifier_hash VARCHAR(255),
    wrapped_vault_key JSONB, wrapped_vault_key_recovery JSONB, encrypted_profile JSONB, vault_version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE notes (
    id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, content JSONB DEFAULT '{}',
    encrypted_content JSONB DEFAULT NULL, encrypted_summary JSONB DEFAULT NULL,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP
  );
  CREATE TABLE blobs (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind VARCHAR(64) NOT NULL,
    mime_type VARCHAR(255), byte_length INTEGER NOT NULL, storage_path TEXT NOT NULL, envelope_iv TEXT NOT NULL,
    envelope_algorithm VARCHAR(64) NOT NULL DEFAULT 'AES-256-GCM', envelope_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
  );
  INSERT INTO users (email, auth_mode, auth_salt) VALUES ('Owner@Example.com', 'e2ee', 'c2FsdHNhbHRzYWx0c2FsdA==');
  INSERT INTO users (email, auth_mode, password_hash) VALUES ('legacy@example.com', 'legacy', 'x');
  INSERT INTO notes (user_id, content, encrypted_content, encrypted_summary)
    VALUES (1, NULL, '{"version":1,"algorithm":"AES-256-GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA=="}', NULL);
  INSERT INTO notes (user_id, content) VALUES (2, '{"type":"doc"}');
  INSERT INTO blobs (user_id, kind, byte_length, storage_path, envelope_iv)
    VALUES (1, 'note-image', 10, 'C:\\FTP\\notes\\server\\storage\\blobs\\1-1-1772818373618.bin', 'iv'),
           (1, 'note-image', 10, '/srv/app/server/storage/blobs/1-2-1772818373675.bin', 'iv'),
           (1, 'note-image', 10, '', 'iv');
`;

describe('ARCH-3: schema migrations', () => {
  let database;
  let pool;

  beforeAll(async () => {
    database = await createTestDatabase({ template: null });
    pool = createPool({ connectionString: database.url, maxConnections: 2 });
    await pool.query(LEGACY_SCHEMA);
  });

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  it('upgrades a 1.x database and is idempotent', async () => {
    const applied = await runMigrations(pool, { log: quiet });
    expect(applied[0]).toBe('001_baseline');
    expect(await runMigrations(pool, { log: quiet })).toEqual([]);
    const status = await getMigrationStatus(pool);
    expect(status.every((m) => m.appliedAt && m.checksumMatches)).toBe(true);
  });

  it('preserves existing ciphertext and plaintext rows untouched', async () => {
    const notes = (await pool.query('SELECT * FROM notes ORDER BY id')).rows;
    expect(notes[0].encrypted_content.version).toBe(1);
    expect(notes[0].revision).toBe(1);
    expect(notes[1].content).toEqual({ type: 'doc' });
  });

  it('derives relative storage keys from absolute Windows and POSIX paths (OPS-2)', async () => {
    const blobs = (await pool.query('SELECT storage_key FROM blobs ORDER BY id')).rows.map((r) => r.storage_key);
    expect(blobs).toEqual(['1-1-1772818373618.bin', '1-2-1772818373675.bin', null]);
  });

  it('converts timestamps to timestamptz and keeps case-insensitive email uniqueness', async () => {
    const types = await pool.query(
      `SELECT DISTINCT data_type FROM information_schema.columns WHERE column_name IN ('created_at','updated_at','deleted_at') AND table_schema='public' AND table_name IN ('users','notes','blobs')`
    );
    expect(types.rows.map((r) => r.data_type)).toEqual(['timestamp with time zone']);
    await expect(pool.query("INSERT INTO users (email, auth_mode) VALUES ('owner@example.com', 'e2ee')")).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('enforces auth_mode values and owned notes', async () => {
    await expect(pool.query("INSERT INTO users (email, auth_mode) VALUES ('x@example.com', 'other')")).rejects.toMatchObject({
      code: '23514',
    });
    await expect(pool.query('INSERT INTO notes (user_id) VALUES (NULL)')).rejects.toMatchObject({ code: '23502' });
  });

  it('defaults new note content to NULL, never to plaintext', async () => {
    const inserted = await pool.query('INSERT INTO notes (user_id) VALUES (1) RETURNING content, revision');
    expect(inserted.rows[0]).toEqual({ content: null, revision: 0 });
  });

  it('refuses to run when an applied migration file was modified', async () => {
    const dir = await fsp.mkdtemp(path.join(process.env.NOTES_TEST_TMPDIR || TEST_DIR, 'migrations-'));
    try {
      const source = path.join(TEST_DIR, '..', 'migrations');
      for (const file of await fsp.readdir(source)) {
        if (file.endsWith('.sql')) {
          await fsp.copyFile(path.join(source, file), path.join(dir, file));
        }
      }
      await fsp.appendFile(path.join(dir, '001_baseline.sql'), '\n-- edited\n');
      await expect(runMigrations(pool, { dir, log: quiet })).rejects.toThrow(/modified after it was applied/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
