import express, { Router } from 'express';
import pool from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  buildBlobFilename,
  deleteFileIfExists,
  readBlobFile,
  writeBlobFile,
} from '../utils/blobStore.js';

const router = Router();

router.use(authenticateToken);

router.post('/', express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (req, res) => {
  try {
    const iv = req.headers['x-blob-iv'];
    const kind = req.headers['x-blob-kind'];
    const mimeType = req.headers['x-blob-mime-type'] || 'application/octet-stream';
    const algorithm = req.headers['x-blob-algorithm'] || 'AES-256-GCM';
    const version = parseInt(req.headers['x-blob-version'] || '1', 10);
    const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);

    if (!iv || !kind || payload.length === 0) {
      return res.status(400).json({ error: 'Missing blob metadata or payload' });
    }

    const insert = await pool.query(
      `
        INSERT INTO blobs (
          user_id,
          kind,
          mime_type,
          byte_length,
          storage_path,
          envelope_iv,
          envelope_algorithm,
          envelope_version
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
      [req.user.id, kind, mimeType, payload.length, '', iv, algorithm, version]
    );

    const blob = insert.rows[0];
    const filename = buildBlobFilename(req.user.id, blob.id);
    const storagePath = await writeBlobFile(filename, payload);

    await pool.query('UPDATE blobs SET storage_path = $1 WHERE id = $2 AND user_id = $3', [
      storagePath,
      blob.id,
      req.user.id,
    ]);

    res.status(201).json({
      blob: {
        id: blob.id,
        kind: blob.kind,
        byteLength: blob.byte_length,
        mimeType: blob.mime_type,
        version: blob.envelope_version,
      },
    });
  } catch (error) {
    console.error('Blob upload error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM blobs WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Blob not found' });
    }

    const blob = result.rows[0];
    const buffer = await readBlobFile(blob.storage_path);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Blob-IV', blob.envelope_iv);
    res.setHeader('X-Blob-Algorithm', blob.envelope_algorithm);
    res.setHeader('X-Blob-Version', String(blob.envelope_version));
    res.setHeader('X-Blob-Mime-Type', blob.mime_type || 'application/octet-stream');
    res.setHeader('X-Blob-Kind', blob.kind);
    res.send(buffer);
  } catch (error) {
    console.error('Blob read error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM blobs WHERE id = $1 AND user_id = $2 RETURNING storage_path',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Blob not found' });
    }

    await deleteFileIfExists(result.rows[0].storage_path);
    res.json({ message: 'Blob deleted' });
  } catch (error) {
    console.error('Blob delete error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
