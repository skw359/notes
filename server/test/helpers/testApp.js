import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { createApp, createContext } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createPool } from '../../db.js';
import { runMigrations } from '../../migrations/runner.js';
import { createTestDatabase } from './database.js';

// No supertest here: the client's integration and browser tests import this
// module to run the real server.

export const TEST_JWT_SECRET = 'test-jwt-secret-for-the-notes-test-suite-0123456789';

const quietLog = { info() {}, warn() {}, error() {} };

/**
 * A fully wired app on a private database and private storage directories.
 * Rate limits and background jobs are off unless a test turns them on.
 */
export async function createTestApp({ env = {}, clientDist, standalone = false } = {}) {
  // `standalone` builds and migrates its own database (for the client's
  // integration tests, which do not run this suite's template setup).
  const database = await createTestDatabase(standalone ? { template: null } : undefined);
  if (standalone) {
    const migrationPool = createPool({ connectionString: database.url, maxConnections: 1 });
    try {
      await runMigrations(migrationPool, { log: { info() {}, warn() {} } });
    } finally {
      await migrationPool.end();
    }
  }
  const root = await fsp.mkdtemp(path.join(process.env.NOTES_TEST_TMPDIR || os.tmpdir(), 'notes-test-'));
  const config = loadConfig({
    JWT_SECRET: TEST_JWT_SECRET,
    DATABASE_URL: database.url,
    DB_POOL_SIZE: '8',
    COOKIE_SECURE: 'false',
    RATE_LIMITS: 'false',
    BACKGROUND_JOBS: 'false',
    STORAGE_ROOT: path.join(root, 'storage'),
    LEGACY_UPLOADS_DIR: path.join(root, 'uploads'),
    ...env,
  });
  const pool = createPool(config.db);
  const ctx = await createContext({ config, pool, log: quietLog, clientDist: clientDist ?? path.join(root, 'no-client') });
  const app = createApp(ctx);

  return {
    app,
    ctx,
    pool,
    config,
    root,
    async close() {
      await pool.end();
      await database.drop();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

export function randomEmail(prefix = 'user') {
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}@example.com`;
}

// Legacy (pre-encryption) accounts can no longer be created through the API.
export async function insertLegacyUser(pool, { email = randomEmail('legacy'), password = 'legacy-password', firstName = 'Leg', lastName = 'Acy' } = {}) {
  const hash = await bcrypt.hash(password, 4);
  const result = await pool.query(
    `
      INSERT INTO users (email, auth_mode, password_hash, first_name, last_name, profile_ref_known)
      VALUES ($1, 'legacy', $2, $3, $4, TRUE) RETURNING *
    `,
    [email, hash, firstName, lastName]
  );
  return { user: result.rows[0], email, password };
}

export async function insertLegacyNote(pool, userId, content, { deleted = false } = {}) {
  const result = await pool.query(
    `
      INSERT INTO notes (user_id, content, revision, blob_refs_known, deleted_at)
      VALUES ($1, $2, 1, TRUE, ${deleted ? 'NOW()' : 'NULL'}) RETURNING *
    `,
    [userId, JSON.stringify(content)]
  );
  return result.rows[0];
}
