import crypto from 'crypto';
import pg from 'pg';

// An admin connection to a disposable PostgreSQL server. Tests create and
// drop their own databases on it; never point this at a real deployment.
export const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:55432/postgres';
export const TEMPLATE_DB = 'notes_test_template';

export function databaseUrl(name) {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function withAdmin(fn) {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase({ template = TEMPLATE_DB } = {}) {
  const name = `notes_test_${crypto.randomBytes(6).toString('hex')}`;
  await withAdmin((admin) =>
    admin.query(template ? `CREATE DATABASE ${name} TEMPLATE ${template}` : `CREATE DATABASE ${name}`)
  );
  return {
    name,
    url: databaseUrl(name),
    drop: () => withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)),
  };
}
