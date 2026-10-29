import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOBS_DIR = path.join(__dirname, '..', 'storage', 'blobs');
const LEGACY_UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

export async function ensureBlobStorage() {
  await fs.mkdir(BLOBS_DIR, { recursive: true });
}

export function buildBlobFilename(userId, blobId) {
  return `${userId}-${blobId}-${Date.now()}.bin`;
}

export function resolveBlobPath(filename) {
  return path.join(BLOBS_DIR, path.basename(filename));
}

export function resolveLegacyUploadPath(filename) {
  return path.join(LEGACY_UPLOADS_DIR, path.basename(filename));
}

export async function writeBlobFile(filename, buffer) {
  await ensureBlobStorage();
  const storagePath = resolveBlobPath(filename);
  await fs.writeFile(storagePath, buffer);
  return storagePath;
}

export async function readBlobFile(storagePath) {
  return fs.readFile(storagePath);
}

export async function deleteFileIfExists(storagePath) {
  try {
    await fs.unlink(storagePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}
