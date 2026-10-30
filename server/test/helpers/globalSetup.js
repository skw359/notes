import { createPool } from '../../db.js';
import { runMigrations } from '../../migrations/runner.js';
import { databaseUrl, TEMPLATE_DB, withAdmin } from './database.js';

// Builds one migrated template database; every test database is a fast copy.
export async function setup() {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  });
  const pool = createPool({ connectionString: databaseUrl(TEMPLATE_DB), maxConnections: 1 });
  try {
    await runMigrations(pool, { log: { info() {}, warn() {} } });
  } finally {
    await pool.end();
  }
}

export async function teardown() {
  await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`));
}
