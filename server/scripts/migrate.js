#!/usr/bin/env node
// Applies pending schema migrations (the server also does this on start).
//   npm run migrate            apply pending migrations
//   npm run migrate -- --status   list migrations and whether they are applied
import { getMigrationStatus, runMigrations } from '../migrations/runner.js';
import { parseFlags, runScript, scriptContext } from './lib.js';

runScript(async () => {
  const flags = parseFlags(process.argv.slice(2));
  const { pool } = scriptContext();
  try {
    if (flags.status) {
      for (const migration of await getMigrationStatus(pool)) {
        const state = migration.appliedAt
          ? `applied ${migration.appliedAt.toISOString()}${migration.checksumMatches ? '' : '  (FILE CHANGED SINCE)'}`
          : 'pending';
        console.log(`${migration.version.padEnd(32)} ${state}`);
      }
      return 0;
    }
    const applied = await runMigrations(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
    return 0;
  } finally {
    await pool.end();
  }
});
