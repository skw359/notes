// OPS-2: compares blob rows with the files in the blob directory. With
// `repair`, a file a row still needs is moved back out of the deleted-files
// area (useful after restoring an older database dump).
export async function verifyStorage({ pool, storage, repair = false }) {
  const rows = (await pool.query('SELECT id, user_id, storage_key, byte_length FROM blobs ORDER BY id')).rows;
  const files = new Set(await storage.listKeys());
  const report = {
    rows: rows.length,
    files: files.size,
    missing: [],
    restored: [],
    sizeMismatch: [],
    noKey: [],
    orphans: [],
  };
  const referencedKeys = new Set();

  for (const row of rows) {
    if (!row.storage_key) {
      report.noKey.push(row.id);
      continue;
    }
    referencedKeys.add(row.storage_key);
    if (!files.has(row.storage_key)) {
      if (repair && (await storage.restoreFromDeleted(row.storage_key))) {
        report.restored.push(row.id);
      } else {
        report.missing.push({ id: row.id, userId: row.user_id, key: row.storage_key });
      }
      continue;
    }
    const info = await storage.stat(row.storage_key);
    if (info && info.size !== Number(row.byte_length)) {
      report.sizeMismatch.push({ id: row.id, expected: Number(row.byte_length), actual: info.size });
    }
  }

  for (const key of files) {
    if (!referencedKeys.has(key)) {
      const info = await storage.stat(key);
      report.orphans.push({ key, size: info?.size ?? 0 });
    }
  }

  report.problems = report.missing.length + report.sizeMismatch.length + report.noKey.length;
  return report;
}
