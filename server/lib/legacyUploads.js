import fsp from 'fs/promises';
import path from 'path';

const LEGACY_URL_RE = /^\/api\/(?:uploads|legacy-uploads)\/([^?#/]+)$/i;

// Filename prefixes written by trusted 1.x code paths, never by users:
//   <userId>-<timestamp>.<ext>        profile pictures (multer)
//   note-<userId>-<timestamp>.<ext>   note images (early 1.x)
//   imported-u<userId>-<hash>-<name>  import-script.js
const OWNER_PREFIX_PATTERNS = [
  { re: /^(\d+)-\d{10,}(?:\.[A-Za-z0-9]{1,10})?$/, source: 'prefix:profile' },
  { re: /^note-(\d+)-\d{10,}(?:\.[A-Za-z0-9]{1,10})?$/, source: 'prefix:note' },
  { re: /^imported-u(\d+)-/, source: 'prefix:import' },
];

// DATA-10: a malformed escape such as "100%.jpg" must not throw.
export function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function isSafeLegacyFilename(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\\0]/.test(name)
  );
}

export function extractLegacyFilenameFromUrl(url) {
  if (typeof url !== 'string') {
    return null;
  }
  const match = url.match(LEGACY_URL_RE);
  if (!match) {
    return null;
  }
  const decoded = safeDecodeURIComponent(match[1]);
  return isSafeLegacyFilename(decoded) ? decoded : null;
}

// Covers image sources and link targets: 1.x imports referenced non-image
// attachments through link marks, which migration used to ignore (CRYPTO-3).
export function extractLegacyFilenamesFromContent(content) {
  const filenames = new Set();

  function walk(node) {
    if (!node || typeof node !== 'object') {
      return;
    }
    const fromSrc = extractLegacyFilenameFromUrl(node.attrs?.src);
    if (fromSrc) {
      filenames.add(fromSrc);
    }
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        const fromHref = extractLegacyFilenameFromUrl(mark?.attrs?.href);
        if (fromHref) {
          filenames.add(fromHref);
        }
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        walk(child);
      }
    }
  }

  walk(content);
  return filenames;
}

export function inferOwnerFromFilename(filename) {
  for (const { re, source } of OWNER_PREFIX_PATTERNS) {
    const match = filename.match(re);
    if (match) {
      return { userId: Number(match[1]), source };
    }
  }
  return null;
}

export async function listLegacyFiles(legacyUploadsDir) {
  let entries;
  try {
    entries = await fsp.readdir(legacyUploadsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSafeLegacyFilename(entry.name) || entry.name.startsWith('.')) {
      continue;
    }
    const info = await fsp.stat(path.join(legacyUploadsDir, entry.name)).catch(() => null);
    if (info) {
      files.push({ filename: entry.name, byteLength: info.size });
    }
  }
  return files;
}

/**
 * SEC-1: record who owns each pre-encryption upload. Ownership comes only
 * from trusted filename prefixes, or - on a single-account instance, where
 * no other tenant exists - from that account. Unprefixed files on multi-user
 * instances stay unassigned (unreadable) until an operator assigns them with
 * `npm run legacy-uploads`; inferring ownership from note text is what
 * allowed cross-account reads before.
 */
export async function backfillLegacyUploads({ pool, legacyUploadsDir, log = console }) {
  const files = await listLegacyFiles(legacyUploadsDir);
  if (!files.length) {
    return { assigned: 0, unassigned: [] };
  }

  const [existing, users] = await Promise.all([
    pool.query('SELECT filename FROM legacy_uploads'),
    pool.query('SELECT id FROM users'),
  ]);
  const known = new Set(existing.rows.map((row) => row.filename));
  const userIds = new Set(users.rows.map((row) => row.id));
  const singleUserId = userIds.size === 1 ? [...userIds][0] : null;

  let assigned = 0;
  const unassigned = [];

  for (const file of files) {
    if (known.has(file.filename)) {
      continue;
    }

    const inferred = inferOwnerFromFilename(file.filename);
    let owner = inferred && userIds.has(inferred.userId) ? inferred : null;
    if (!owner && inferred && !userIds.has(inferred.userId)) {
      // Prefixed for an account that no longer exists: never hand it to anyone.
      continue;
    }
    if (!owner && singleUserId !== null) {
      owner = { userId: singleUserId, source: 'single-user' };
    }
    if (!owner) {
      unassigned.push(file.filename);
      continue;
    }

    const result = await pool.query(
      `
        INSERT INTO legacy_uploads (filename, user_id, source, byte_length)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (filename) DO NOTHING
      `,
      [file.filename, owner.userId, owner.source, file.byteLength]
    );
    assigned += result.rowCount;
  }

  if (unassigned.length) {
    log.warn?.(
      `[legacy-uploads] ${unassigned.length} pre-encryption upload(s) have no provable owner and stay ` +
        'unreadable; run `npm run legacy-uploads -- --report` to review them'
    );
  }

  return { assigned, unassigned };
}

/**
 * Moves a plaintext legacy file out of the served directory into the
 * quarantine area, where the maintenance job deletes it after
 * LEGACY_QUARANTINE_DAYS. Quarantine instead of immediate deletion keeps a
 * recovery window if a client reported a migration that turns out broken.
 */
export async function quarantineLegacyFile({ legacyUploadsDir, legacyQuarantineDir }, filename) {
  if (!isSafeLegacyFilename(filename)) {
    return false;
  }
  await fsp.mkdir(legacyQuarantineDir, { recursive: true });
  const target = path.join(legacyQuarantineDir, `${Date.now()}-${filename}`);
  try {
    await fsp.rename(path.join(legacyUploadsDir, filename), target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    if (error.code === 'EXDEV') {
      await fsp.copyFile(path.join(legacyUploadsDir, filename), target);
      await fsp.unlink(path.join(legacyUploadsDir, filename));
      return true;
    }
    throw error;
  }
}

export async function sweepLegacyQuarantine(legacyQuarantineDir, olderThanMs) {
  let names;
  try {
    names = await fsp.readdir(legacyQuarantineDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const name of names) {
    const match = name.match(/^(\d{13})-/);
    if (match && Number(match[1]) <= cutoff) {
      await fsp.rm(path.join(legacyQuarantineDir, name), { force: true });
      removed += 1;
    }
  }
  return removed;
}

// Best-effort content type for files the owner downloads during migration.
const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain',
};

export function guessMimeType(filename) {
  return MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}
