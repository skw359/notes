#!/usr/bin/env node
// CRYPTO-3: lists plaintext the server still holds outside the encrypted
// vaults, so an operator can verify the encrypted copies and then remove it.
// Read-only: this script never deletes or moves anything.
import fsp from 'fs/promises';
import path from 'path';
import { SERVER_DIR } from '../config.js';
import { listLegacyFiles } from '../lib/legacyUploads.js';
import { formatBytes, runScript, scriptContext } from './lib.js';

async function sizeOf(target) {
  const info = await fsp.stat(target).catch(() => null);
  if (!info) {
    return null;
  }
  if (info.isFile()) {
    return { files: 1, bytes: info.size };
  }
  let files = 0;
  let bytes = 0;
  for (const entry of await fsp.readdir(target, { withFileTypes: true })) {
    const child = await sizeOf(path.join(target, entry.name));
    if (child) {
      files += child.files;
      bytes += child.bytes;
    }
  }
  return { files, bytes };
}

runScript(async () => {
  const { config, pool } = scriptContext();
  try {
    console.log('Plaintext still stored by this server\n');

    const legacy = await listLegacyFiles(config.storage.legacyUploadsDir);
    const states = new Map(
      (await pool.query('SELECT filename, user_id, migrated_at FROM legacy_uploads')).rows.map((row) => [row.filename, row])
    );
    const migrated = legacy.filter((file) => states.get(file.filename)?.migrated_at);
    console.log(`1. Pre-encryption uploads in ${config.storage.legacyUploadsDir}`);
    console.log(`   ${legacy.length} file(s), ${formatBytes(legacy.reduce((sum, f) => sum + f.byteLength, 0))}`);
    console.log(`   ${migrated.length} already have an encrypted copy (reported by the owner's client)`);
    console.log('   Encrypted accounts can rescue files their notes still link to from Settings > Encryption.');

    const quarantine = await sizeOf(config.storage.legacyQuarantineDir);
    console.log(`\n2. Quarantined uploads awaiting deletion (${config.storage.legacyQuarantineDir})`);
    console.log(`   ${quarantine ? `${quarantine.files} file(s), ${formatBytes(quarantine.bytes)}` : 'none'}`);
    console.log(`   Deleted automatically after LEGACY_QUARANTINE_DAYS (${config.retention.legacyQuarantineMs / 86400000} days).`);

    const leftovers = [
      ['Import backups written by the removed server-side importer', path.join(SERVER_DIR, 'import-backups')],
      ['SQL dump written by the removed HTML importer', path.join(SERVER_DIR, 'import-notes.sql')],
    ];
    console.log('\n3. Files from the removed server-side importers');
    for (const [label, target] of leftovers) {
      const size = await sizeOf(target);
      console.log(`   ${label}: ${size ? `${target} (${size.files} file(s), ${formatBytes(size.bytes)})` : 'none'}`);
    }

    const residue = await pool.query(`
      SELECT u.id, COUNT(n.*)::int AS count
      FROM notes n JOIN users u ON u.id = n.user_id
      WHERE u.auth_mode = 'e2ee' AND n.content IS NOT NULL
      GROUP BY u.id
    `);
    console.log('\n4. Plaintext note rows inside encrypted accounts');
    console.log(
      residue.rows.length
        ? residue.rows.map((row) => `   user ${row.id}: ${row.count} note(s) (encrypted automatically on the owner's next unlock)`).join('\n')
        : '   none'
    );

    const legacyUsers = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE auth_mode = 'legacy'");
    console.log(`\n5. Accounts not yet migrated to encryption: ${legacyUsers.rows[0].count}`);
    console.log('   Their notes stay plaintext until the owner logs in and completes the upgrade.');
    console.log('\nNothing was changed. Verify encrypted copies before deleting anything listed above.');
    return 0;
  } finally {
    await pool.end();
  }
});
