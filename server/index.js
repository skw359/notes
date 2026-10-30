import dotenv from 'dotenv';
import { createApp, createContext } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { backfillLegacyUploads } from './lib/legacyUploads.js';
import { runMigrations } from './migrations/runner.js';
import { startMaintenanceSchedule } from './services/maintenance.js';

dotenv.config();

async function start() {
  const config = loadConfig();
  const pool = createPool(config.db);

  const applied = await runMigrations(pool);
  if (applied.length) {
    console.log(`Applied database migrations: ${applied.join(', ')}`);
  }

  const ctx = await createContext({ config, pool });
  await backfillLegacyUploads({ pool, legacyUploadsDir: config.storage.legacyUploadsDir });

  if (config.cookie.secure === 'false') {
    console.warn('COOKIE_SECURE=false: session cookies are sent over plain HTTP. Use this for local development only.');
  }

  const app = createApp(ctx);
  const server = config.host
    ? app.listen(config.port, config.host, () => console.log(`Server running on ${config.host}:${config.port}`))
    : app.listen(config.port, () => console.log(`Server running on port ${config.port}`));

  const maintenance = config.jobs.enabled ? startMaintenanceSchedule(ctx) : null;

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    maintenance?.stop();
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
