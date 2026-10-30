import dotenv from 'dotenv';
import path from 'path';
import { loadConfig, SERVER_DIR } from '../config.js';
import { createPool } from '../db.js';

// Shared bootstrap for the operator scripts: same .env and config as the server.
export function scriptContext() {
  dotenv.config({ path: path.join(SERVER_DIR, '.env') });
  const config = loadConfig();
  const pool = createPool({ ...config.db, maxConnections: 2 });
  return { config, pool };
}

export function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      flags[name] = inline ?? true;
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

export function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export async function runScript(main) {
  try {
    process.exitCode = (await main()) ?? 0;
  } catch (error) {
    console.error(`[fatal] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
