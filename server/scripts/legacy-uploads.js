#!/usr/bin/env node
// SEC-1: ownership of pre-encryption upload files (server/uploads).
//   npm run legacy-uploads -- --report
//       list files and their recorded owners; unassigned files are unreadable
//   npm run legacy-uploads -- --assign <filename> <userId>
//       record an owner after checking it yourself
//   npm run legacy-uploads -- --assign-by-reference
//       assign each unassigned file referenced by exactly ONE legacy account's
//       notes. Note text is user-controlled, so review --report first.
import {
  backfillLegacyUploads,
  extractLegacyFilenamesFromContent,
  isSafeLegacyFilename,
  listLegacyFiles,
} from '../lib/legacyUploads.js';
import { formatBytes, parseFlags, runScript, scriptContext } from './lib.js';

async function referencesByFile(pool) {
  const notes = await pool.query(
    `SELECT n.user_id, n.content FROM notes n JOIN users u ON u.id = n.user_id WHERE u.auth_mode = 'legacy' AND n.content IS NOT NULL`
  );
  const map = new Map();
  for (const row of notes.rows) {
    for (const filename of extractLegacyFilenamesFromContent(row.content)) {
      if (!map.has(filename)) {
        map.set(filename, new Set());
      }
      map.get(filename).add(row.user_id);
    }
  }
  return map;
}

runScript(async () => {
  const flags = parseFlags(process.argv.slice(2));
  const { config, pool } = scriptContext();
  const dir = config.storage.legacyUploadsDir;
  try {
    await backfillLegacyUploads({ pool, legacyUploadsDir: dir, log: { warn() {} } });

    if (flags.assign) {
      const [filename, userIdText] = flags._;
      const userId = Number(userIdText);
      if (!isSafeLegacyFilename(filename) || !Number.isInteger(userId)) {
        console.error('Usage: --assign <filename> <userId>');
        return 1;
      }
      const user = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (!user.rows.length) {
        console.error(`No user ${userId}`);
        return 1;
      }
      await pool.query(
        `INSERT INTO legacy_uploads (filename, user_id, source) VALUES ($1, $2, 'operator')
         ON CONFLICT (filename) DO UPDATE SET user_id = EXCLUDED.user_id, source = 'operator'`,
        [filename, userId]
      );
      console.log(`Assigned ${filename} to user ${userId}.`);
      return 0;
    }

    const files = await listLegacyFiles(dir);
    const owners = new Map(
      (await pool.query('SELECT filename, user_id, source FROM legacy_uploads')).rows.map((row) => [row.filename, row])
    );
    const references = await referencesByFile(pool);
    const unassigned = files.filter((file) => !owners.has(file.filename));

    if (flags['assign-by-reference']) {
      let assigned = 0;
      for (const file of unassigned) {
        const users = references.get(file.filename);
        if (users?.size === 1) {
          await pool.query(
            `INSERT INTO legacy_uploads (filename, user_id, source, byte_length) VALUES ($1, $2, 'reference', $3)
             ON CONFLICT (filename) DO NOTHING`,
            [file.filename, [...users][0], file.byteLength]
          );
          assigned += 1;
        }
      }
      console.log(`Assigned ${assigned} file(s) by unique reference.`);
      return 0;
    }

    console.log(`Legacy upload directory: ${dir}`);
    console.log(`Files: ${files.length} (${formatBytes(files.reduce((sum, f) => sum + f.byteLength, 0))})`);
    for (const file of files) {
      const owner = owners.get(file.filename);
      const refs = references.get(file.filename);
      const candidates = refs ? ` referenced by legacy user(s) ${[...refs].join(', ')}` : '';
      console.log(
        owner
          ? `  owner ${String(owner.user_id).padEnd(5)} (${owner.source.padEnd(14)}) ${file.filename}`
          : `  UNASSIGNED                     ${file.filename}${candidates}`
      );
    }
    if (unassigned.length) {
      console.log(`\n${unassigned.length} file(s) have no owner and cannot be read by anyone.`);
    }
    return 0;
  } finally {
    await pool.end();
  }
});
