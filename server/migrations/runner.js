import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { LOCK_NAMESPACE } from '../db.js';

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;

export async function listMigrations(dir = MIGRATIONS_DIR) {
  const files = (await fs.readdir(dir)).filter((file) => MIGRATION_FILE_RE.test(file)).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      return {
        version: file.replace(/\.sql$/, ''),
        sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      };
    })
  );
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getMigrationStatus(pool, { dir } = {}) {
  const migrations = await listMigrations(dir);
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await client.query('SELECT version, checksum, applied_at FROM schema_migrations');
    const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row]));
    return migrations.map((migration) => {
      const row = appliedByVersion.get(migration.version);
      return {
        version: migration.version,
        appliedAt: row?.applied_at || null,
        checksumMatches: row ? row.checksum === migration.checksum : null,
      };
    });
  } finally {
    client.release();
  }
}

// Applies pending migrations in order, each in its own transaction, under an
// advisory lock so concurrently starting instances cannot race. An applied
// migration whose file has since changed is a hard error: silently diverging
// schemas are how data gets corrupted.
export async function runMigrations(pool, { dir, log = console } = {}) {
  const migrations = await listMigrations(dir);
  const client = await pool.connect();
  const appliedNow = [];
  // Only RAISE WARNINGs matter; plain NOTICEs are "already exists, skipping".
  const onNotice = (notice) => {
    if (notice.severity === 'WARNING') {
      log.warn?.(`[migrate] warning: ${notice.message}`);
    }
  };
  client.on('notice', onNotice);

  try {
    await client.query('SELECT pg_advisory_lock($1, 0)', [LOCK_NAMESPACE.migrations]);
    await ensureMigrationsTable(client);

    const applied = await client.query('SELECT version, checksum FROM schema_migrations');
    const appliedChecksums = new Map(applied.rows.map((row) => [row.version, row.checksum]));

    for (const migration of migrations) {
      const existingChecksum = appliedChecksums.get(migration.version);
      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.version} was modified after it was applied. ` +
              'Restore the original file; schema changes belong in a new migration.'
          );
        }
        continue;
      }

      log.info?.(`[migrate] applying ${migration.version}`);
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          migration.version,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        error.message = `Migration ${migration.version} failed: ${error.message}`;
        throw error;
      }
      appliedNow.push(migration.version);
    }

    return appliedNow;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, 0)', [LOCK_NAMESPACE.migrations]).catch(() => {});
    client.off('notice', onNotice);
    client.release();
  }
}
