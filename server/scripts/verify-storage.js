#!/usr/bin/env node
// OPS-2: checks that the database and the blob directory agree.
//   npm run verify-storage                 report only (read-only)
//   npm run verify-storage -- --repair     move files a row needs back out of
//                                          the deleted-files area (after a restore)
//   npm run verify-storage -- --json       machine-readable output
// Exit code 0 = consistent, 2 = problems found.
import { createBlobStorage } from '../lib/blobStorage.js';
import { verifyStorage } from '../lib/verifyStorage.js';
import { formatBytes, parseFlags, runScript, scriptContext } from './lib.js';

runScript(async () => {
  const flags = parseFlags(process.argv.slice(2));
  const { config, pool } = scriptContext();
  try {
    const storage = createBlobStorage(config.storage);
    const report = await verifyStorage({ pool, storage, repair: Boolean(flags.repair) });

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Blob directory: ${config.storage.blobsDir}`);
      console.log(`Rows: ${report.rows}   Files: ${report.files}`);
      if (report.restored.length) {
        console.log(`Restored from the deleted-files area: ${report.restored.length}`);
      }
      for (const item of report.missing) {
        console.log(`MISSING  blob ${item.id} (user ${item.userId}) expects ${item.key}`);
      }
      for (const item of report.sizeMismatch) {
        console.log(`SIZE     blob ${item.id}: expected ${item.expected} bytes, file has ${item.actual}`);
      }
      for (const id of report.noKey) {
        console.log(`NO FILE  blob ${id} has no storage key (a failed 1.x upload)`);
      }
      const orphanBytes = report.orphans.reduce((sum, item) => sum + item.size, 0);
      console.log(
        `Orphan files (no row; harmless, e.g. uploads interrupted before commit): ${report.orphans.length} (${formatBytes(orphanBytes)})`
      );
      console.log(report.problems ? `\n${report.problems} problem(s) found.` : '\nStorage is consistent.');
    }
    return report.problems ? 2 : 0;
  } finally {
    await pool.end();
  }
});
