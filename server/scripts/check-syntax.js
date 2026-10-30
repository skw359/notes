#!/usr/bin/env node
// Parses every server source file (CI and pre-deploy sanity check).
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { SERVER_DIR } from '../config.js';

function collect(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collect(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

let failures = 0;
for (const file of collect(SERVER_DIR)) {
  try {
    // execFileSync passes arguments without a shell.
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures += 1;
    console.error(`${path.relative(SERVER_DIR, file)}:\n${error.stderr?.toString() || error.message}`);
  }
}
console.log(failures ? `${failures} file(s) failed to parse` : 'All server files parse.');
process.exitCode = failures ? 1 : 0;
