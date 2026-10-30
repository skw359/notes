import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

const STORAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const TEMP_PREFIX = '.tmp-';
const DELETED_NAME_RE = /^(\d{13})-(.+)$/;

export function isValidStorageKey(key) {
  return typeof key === 'string' && STORAGE_KEY_RE.test(key) && !key.includes('..');
}

export class BlobTooLargeError extends Error {
  constructor(limit) {
    super('Blob exceeds the size limit');
    this.code = 'BLOB_TOO_LARGE';
    this.limit = limit;
  }
}

async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    await fsp.unlink(from);
  }
}

/**
 * Encrypted blobs on disk. Rows store only a storage key (a bare filename)
 * resolved against the configured directory, so the data directory can be
 * moved or restored elsewhere (OPS-2). Files are written to a temp name and
 * renamed into place only once the database row exists, and deletions move
 * files into a holding area that is swept later, so a backup taken during
 * garbage collection can still be made consistent.
 */
export function createBlobStorage({ blobsDir, deletedBlobsDir }) {
  async function init() {
    await fsp.mkdir(blobsDir, { recursive: true });
    await fsp.mkdir(deletedBlobsDir, { recursive: true });
  }

  function resolve(key) {
    if (!isValidStorageKey(key)) {
      throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    }
    return path.join(blobsDir, key);
  }

  function newKey(userId) {
    return `u${userId}-${crypto.randomBytes(12).toString('hex')}.bin`;
  }

  // Streams a request body to a temp file, aborting once maxBytes is exceeded
  // so oversized uploads never sit in memory.
  async function receive(readable, { maxBytes }) {
    await init();
    const tempPath = path.join(blobsDir, `${TEMP_PREFIX}${crypto.randomBytes(12).toString('hex')}`);
    let size = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(new BlobTooLargeError(maxBytes));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(readable, limiter, fs.createWriteStream(tempPath, { flags: 'wx' }));
    } catch (error) {
      await fsp.rm(tempPath, { force: true });
      throw error;
    }
    return { tempPath, size };
  }

  async function commit(tempPath, key) {
    await fsp.rename(tempPath, resolve(key));
  }

  async function discard(tempPath) {
    await fsp.rm(tempPath, { force: true });
  }

  function createReadStream(key) {
    return fs.createReadStream(resolve(key));
  }

  async function stat(key) {
    try {
      return await fsp.stat(resolve(key));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  // Moves a blob file into the deleted-files area (final removal happens in
  // sweepDeleted). Returns false when the file is already gone.
  async function moveToDeleted(key) {
    if (!isValidStorageKey(key)) {
      return false;
    }
    await fsp.mkdir(deletedBlobsDir, { recursive: true });
    try {
      await moveFile(path.join(blobsDir, key), path.join(deletedBlobsDir, `${Date.now()}-${key}`));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async function listDeleted() {
    let names;
    try {
      names = await fsp.readdir(deletedBlobsDir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    return names
      .map((name) => {
        const match = name.match(DELETED_NAME_RE);
        return match ? { name, deletedAt: Number(match[1]), key: match[2] } : null;
      })
      .filter(Boolean);
  }

  async function sweepDeleted(olderThanMs) {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const entry of await listDeleted()) {
      if (entry.deletedAt <= cutoff) {
        await fsp.rm(path.join(deletedBlobsDir, entry.name), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  // Used by verify-storage --repair after restoring a backup.
  async function restoreFromDeleted(key) {
    const candidates = (await listDeleted())
      .filter((entry) => entry.key === key)
      .sort((a, b) => b.deletedAt - a.deletedAt);
    if (!candidates.length) {
      return false;
    }
    await moveFile(path.join(deletedBlobsDir, candidates[0].name), resolve(key));
    return true;
  }

  async function listKeys() {
    let names;
    try {
      names = await fsp.readdir(blobsDir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    return names.filter((name) => !name.startsWith(TEMP_PREFIX));
  }

  async function cleanupTemp(olderThanMs) {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    let names = [];
    try {
      names = await fsp.readdir(blobsDir);
    } catch {
      return 0;
    }
    for (const name of names.filter((entry) => entry.startsWith(TEMP_PREFIX))) {
      const filePath = path.join(blobsDir, name);
      const info = await fsp.stat(filePath).catch(() => null);
      if (info && info.mtimeMs <= cutoff) {
        await fsp.rm(filePath, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  return {
    blobsDir,
    deletedBlobsDir,
    init,
    resolve,
    newKey,
    receive,
    commit,
    discard,
    createReadStream,
    stat,
    moveToDeleted,
    sweepDeleted,
    restoreFromDeleted,
    listKeys,
    cleanupTemp,
  };
}
