import path from 'path';
import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { guessMimeType, isSafeLegacyFilename, quarantineLegacyFile } from '../lib/legacyUploads.js';
import { idSchema, parseBody } from '../lib/validation.js';

const filenameSchema = z.string().min(1).max(255).refine(isSafeLegacyFilename, 'Invalid filename');

// Pre-encryption files. Reads are authorized solely by the legacy_uploads
// ownership table (SEC-1); nothing is inferred from note content anymore.
export function createLegacyUploadsRouter(ctx) {
  const { pool, config, limiters, requireSession } = ctx;
  const router = Router();

  router.use(requireSession, limiters.api);

  async function ownedFile(userId, filename) {
    const result = await pool.query(
      `
        SELECT filename, byte_length, migrated_at, quarantined_at FROM legacy_uploads
        WHERE filename = $1 AND user_id = $2
      `,
      [filename, userId]
    );
    return result.rows[0] || null;
  }

  router.get('/', async (req, res) => {
    const result = await pool.query(
      `
        SELECT filename, byte_length, migrated_at
        FROM legacy_uploads
        WHERE user_id = $1 AND quarantined_at IS NULL
        ORDER BY filename
      `,
      [req.user.id]
    );
    res.json({
      files: result.rows.map((row) => ({
        filename: row.filename,
        byteLength: row.byte_length,
        migratedAt: row.migrated_at,
        mimeType: guessMimeType(row.filename),
      })),
    });
  });

  router.get('/:filename', async (req, res) => {
    const filename = filenameSchema.parse(req.params.filename);
    const file = await ownedFile(req.user.id, filename);
    if (!file || file.quarantined_at) {
      throw notFound('File not found', 'FILE_NOT_FOUND');
    }

    // The client fetches these to encrypt them; they are never rendered by
    // the browser directly.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Legacy-Mime-Type', guessMimeType(filename));
    await new Promise((resolve, reject) => {
      res.sendFile(path.join(config.storage.legacyUploadsDir, filename), { dotfiles: 'deny' }, (error) => {
        if (!error) {
          resolve();
        } else if (error.code === 'ENOENT' || error.status === 404) {
          if (!res.headersSent) {
            res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
          }
          resolve();
        } else {
          reject(error);
        }
      });
    });
  });

  // The owner's client re-encrypted this file into a blob and saved every
  // note that referenced it; the plaintext original moves to quarantine.
  router.post('/:filename/migrated', async (req, res) => {
    const filename = filenameSchema.parse(req.params.filename);
    const { blobId } = parseBody(z.strictObject({ blobId: idSchema }), req.body);
    const file = await ownedFile(req.user.id, filename);
    if (!file || file.quarantined_at) {
      throw notFound('File not found', 'FILE_NOT_FOUND');
    }
    const blob = await pool.query('SELECT id FROM blobs WHERE id = $1 AND user_id = $2', [blobId, req.user.id]);
    if (!blob.rows.length) {
      throw notFound('Blob not found', 'BLOB_NOT_FOUND');
    }

    await pool.query(
      `
        UPDATE legacy_uploads SET migrated_blob_id = $3, migrated_at = NOW()
        WHERE filename = $1 AND user_id = $2
      `,
      [filename, req.user.id, blobId]
    );
    const moved = await quarantineLegacyFile(config.storage, filename);
    await pool.query('UPDATE legacy_uploads SET quarantined_at = NOW() WHERE filename = $1', [filename]);
    res.json({ quarantined: moved });
  });

  return router;
}
