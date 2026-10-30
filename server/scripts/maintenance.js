#!/usr/bin/env node
// Runs the scheduled maintenance tasks once (trash expiry, blob garbage
// collection, file sweeps, session cleanup). Safe next to a running server:
// overlapping runs skip themselves.
import { createBlobStorage } from '../lib/blobStorage.js';
import { runMaintenance } from '../services/maintenance.js';
import { runScript, scriptContext } from './lib.js';

runScript(async () => {
  const { config, pool } = scriptContext();
  try {
    const storage = createBlobStorage(config.storage);
    await storage.init();
    const results = await runMaintenance({ pool, storage, config, log: console });
    console.log(JSON.stringify(results, null, 2));
    return 0;
  } finally {
    await pool.end();
  }
});
