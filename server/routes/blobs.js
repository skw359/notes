import express, { Router } from 'express';
import { pipeline } from 'stream';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { base64DecodedLength, idListSchema, idSchema, KEY_ID_RE, parseBody } from '../lib/validation.js';
import { gcStatus, findBlob, reconcileRefs, requestBlobDeletion, storageUsage, uploadBlob } from '../services/blobs.js';

const reconcileSchema = z.strictObject({
  notes: z
    .array(z.strictObject({ id: idSchema, revision: z.number().int().min(0), blobIds: idListSchema }))
    .max(2000)
    .default([]),
  revisions: z.array(z.strictObject({ id: idSchema, blobIds: idListSchema })).max(5000).default([]),
  // profileIv: the IV of the profile envelope the client decrypted.
  profile: z.strictObject({ blobId: idSchema.nullable(), profileIv: z.string().max(64).nullable() }).optional(),
});

function parseUploadHeaders(req) {
  const version = Number(req.get('x-blob-version') || '1');
  if (![2, 3].includes(version)) {
    throw badRequest('Unsupported blob format version', 'INVALID_BLOB');
  }
  const iv = req.get('x-blob-iv') || null;
  const keyId = req.get('x-blob-key-id') || null;
  if (version === 2 && base64DecodedLength(iv) !== 12) {
    throw badRequest('Version 2 blobs need a 12-byte IV header', 'INVALID_BLOB');
  }
  if (version === 3) {
    // v3 blobs carry per-chunk IVs inline and must name their key.
    if (!keyId || !KEY_ID_RE.test(keyId)) {
      throw badRequest('Version 3 blobs need a key id', 'INVALID_BLOB');
    }
  }
  const replacesHeader = req.get('x-blob-replaces');
  const replaces = replacesHeader ? idSchema.parse(replacesHeader) : null;
  return { version, iv: version === 2 ? iv : null, keyId: version === 3 ? keyId : null, replaces };
}

export function createBlobsRouter(ctx) {
  const { pool, config, storage, limiters, requireSession } = ctx;
  const router = Router();
  const json = express.json({ limit: config.limits.notesBodyBytes });

  router.use(requireSession, limiters.api);

  // Legacy accounts upload here too while migrating to encryption.
  router.post('/', async (req, res) => {
    if (!req.is('application/octet-stream')) {
      throw badRequest('Uploads must be sent as application/octet-stream', 'UNSUPPORTED_MEDIA_TYPE');
    }
    const meta = parseUploadHeaders(req);
    const blob = await uploadBlob({ pool, storage, config, user: req.user, req, meta });
    res.status(201).json({
      blob: {
        id: blob.id,
        byteLength: blob.byte_length,
        version: blob.envelope_version,
        keyId: blob.key_id,
      },
    });
  });

  router.get('/usage', async (req, res) => {
    const usage = await storageUsage(pool, req.user.id);
    res.json({
      usedBytes: usage.bytes,
      blobCount: usage.count,
      quotaBytes: config.limits.userQuotaBytes || null,
      maxBlobBytes: config.limits.maxBlobBytes,
      gc: await gcStatus(pool, req.user.id),
    });
  });

  // What the client still has to scan before garbage collection can run.
  router.get('/refs/unknown', async (req, res) => {
    const [notes, revisions, user] = await Promise.all([
      pool.query('SELECT id, revision FROM notes WHERE user_id = $1 AND NOT blob_refs_known ORDER BY id LIMIT 5000', [
        req.user.id,
      ]),
      pool.query(
        'SELECT id, note_id FROM note_revisions WHERE user_id = $1 AND NOT blob_refs_known ORDER BY id LIMIT 5000',
        [req.user.id]
      ),
      pool.query('SELECT profile_ref_known FROM users WHERE id = $1', [req.user.id]),
    ]);
    res.json({
      notes: notes.rows,
      revisions: revisions.rows.map((row) => ({ id: row.id, noteId: row.note_id })),
      profileRefKnown: Boolean(user.rows[0]?.profile_ref_known),
    });
  });

  router.post('/refs/reconcile', json, async (req, res) => {
    const body = parseBody(reconcileSchema, req.body);
    res.json(await reconcileRefs(pool, req.user, body));
  });

  router.get('/:id', async (req, res) => {
    const blob = await findBlob(pool, req.user, idSchema.parse(req.params.id));
    const info = blob.storage_key ? await storage.stat(blob.storage_key) : null;
    if (!info) {
      console.error(`[blobs] file missing for blob ${blob.id} (key ${blob.storage_key})`);
      res.status(404).json({ error: 'The file for this attachment is missing', code: 'BLOB_FILE_MISSING' });
      return;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(info.size));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Blob-Algorithm', blob.envelope_algorithm);
    res.setHeader('X-Blob-Version', String(blob.envelope_version));
    if (blob.envelope_iv) {
      res.setHeader('X-Blob-IV', blob.envelope_iv);
    }
    if (blob.key_id) {
      res.setHeader('X-Blob-Key-Id', blob.key_id);
    }

    // Streamed instead of read into memory.
    await new Promise((resolve) => {
      pipeline(storage.createReadStream(blob.storage_key), res, (error) => {
        if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          console.error(`[blobs] stream error for blob ${blob.id}:`, error.message);
        }
        resolve();
      });
    });
  });

  router.delete('/:id', async (req, res) => {
    await requestBlobDeletion(pool, req.user, idSchema.parse(req.params.id));
    res.status(202).json({ message: 'Scheduled for deletion once unused' });
  });

  return router;
}
