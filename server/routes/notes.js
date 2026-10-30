import { Router } from 'express';
import { z } from 'zod';
import { badRequest, conflict } from '../lib/errors.js';
import { CONTEXTS, idListSchema, idSchema, parseBody, parseEnvelope } from '../lib/validation.js';
import { currentVaultKeyId } from '../services/accounts.js';
import {
  createNote,
  deleteNotePermanently,
  getNote,
  getNotesBatch,
  getRevision,
  listNotes,
  listRevisions,
  reencryptRevision,
  resolveConflict,
  restoreNote,
  saveEncryptedNote,
  saveLegacyNote,
  syncChanges,
  trashNote,
  updateSummary,
} from '../services/notes.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  cursor: z.string().max(512).optional(),
});

const syncQuerySchema = z.object({
  since: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

const legacyContentSchema = z.looseObject({ type: z.literal('doc') });

// Imports keep the original dates of the notes they bring in.
const pastTimestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => new Date(value).getTime() <= Date.now() + 60 * 1000, 'Timestamp is in the future');

const encryptedSaveSchema = z.strictObject({
  baseRevision: z.number().int().min(0).optional(),
  encryptedContent: z.unknown(),
  encryptedSummary: z.unknown().optional(),
  blobIds: idListSchema.optional(),
  reason: z.enum(['edit', 'restore', 'conflict-resolution', 'import', 'reencrypt']).default('edit'),
  updatedAt: pastTimestamp.optional(),
});

const legacySaveSchema = z.strictObject({
  baseRevision: z.number().int().min(0).optional(),
  content: legacyContentSchema,
});

const reencryptRevisionSchema = z.strictObject({
  encryptedContent: z.unknown(),
  encryptedSummary: z.unknown().optional(),
  blobIds: idListSchema.optional(),
});

function noteIdFrom(req) {
  return idSchema.parse(req.params.id);
}

function assertLegacyContentSize(content, config) {
  if (Buffer.byteLength(JSON.stringify(content)) > config.limits.noteMaxBytes) {
    throw badRequest('This note is too large to save', 'PAYLOAD_TOO_LARGE', { limit: config.limits.noteMaxBytes });
  }
}

function parseOptionalSummary(value, noteId, label, keyId) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return parseEnvelope(value, { context: CONTEXTS.noteSummary(noteId), label, maxBytes: 64 * 1024, keyId });
}

export function createNotesRouter(ctx) {
  const { pool, config, limiters, requireSession } = ctx;
  const router = Router();

  router.use(requireSession, limiters.api);

  router.get('/', async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(await listNotes(pool, req.user, { scope: 'active', ...query }));
  });

  // Listing the trash no longer purges it; expiry is a scheduled job.
  router.get('/trash', async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(await listNotes(pool, req.user, { scope: 'trash', ...query }));
  });

  router.get('/sync', async (req, res) => {
    res.json(await syncChanges(pool, req.user, syncQuerySchema.parse(req.query)));
  });

  router.post('/batch', async (req, res) => {
    const { ids } = parseBody(
      z.strictObject({ ids: z.array(idSchema).min(1).max(config.limits.batchMaxIds) }),
      req.body
    );
    res.json(await getNotesBatch(pool, req.user, [...new Set(ids)]));
  });

  router.get('/:id', async (req, res) => {
    res.json({ note: await getNote(pool, req.user, noteIdFrom(req)) });
  });

  router.post('/', async (req, res) => {
    let content = null;
    let createdAt;
    if (req.user.authMode === 'e2ee') {
      // Encrypted notes are created empty; their ciphertext is bound to the
      // id and arrives with the first save. A plaintext body here comes from
      // a stale client (DATA-1).
      if (req.body?.content !== undefined) {
        throw conflict('This account is end-to-end encrypted. Reload the app to continue.', 'CLIENT_OUTDATED');
      }
      createdAt = parseBody(z.object({ createdAt: pastTimestamp.optional() }), req.body).createdAt;
    } else {
      content = parseBody(z.object({ content: legacyContentSchema.optional() }), req.body).content || {
        type: 'doc',
        content: [{ type: 'paragraph' }],
      };
      assertLegacyContentSize(content, config);
    }

    res.status(201).json({ note: await createNote(pool, req.user, { content, config, createdAt }) });
  });

  router.put('/:id', async (req, res) => {
    const noteId = noteIdFrom(req);

    if (req.user.authMode !== 'e2ee') {
      const body = parseBody(legacySaveSchema, req.body);
      assertLegacyContentSize(body.content, config);
      res.json({ note: await saveLegacyNote(pool, req.user, noteId, body) });
      return;
    }

    // DATA-1: an encrypted account must never accept plaintext or a save
    // without ciphertext; both used to erase the note's only copy.
    if (req.body?.content !== undefined) {
      throw conflict('This account is end-to-end encrypted. Reload the app to continue.', 'CLIENT_OUTDATED');
    }
    const body = parseBody(encryptedSaveSchema, req.body);
    if (body.encryptedContent === undefined || body.encryptedContent === null) {
      throw badRequest('encryptedContent is required', 'INVALID_ENVELOPE');
    }

    const encryptedContent = parseEnvelope(body.encryptedContent, {
      context: CONTEXTS.noteContent(noteId),
      label: 'note content',
      maxBytes: config.limits.noteMaxBytes,
      revision: body.baseRevision === undefined ? undefined : body.baseRevision + 1,
    });
    const encryptedSummary = parseOptionalSummary(body.encryptedSummary, noteId, 'note summary');

    const result = await saveEncryptedNote(pool, config, req.user, req.session.id, noteId, {
      baseRevision: body.baseRevision,
      encryptedContent,
      encryptedSummary,
      blobIds: body.blobIds,
      reason: body.reason,
      updatedAt: body.reason === 'import' ? body.updatedAt : undefined,
    });

    if (result.status === 'conflict') {
      res.status(409).json({
        error: result.message,
        code: result.code,
        conflictRevisionId: result.conflictRevisionId,
        note: result.note,
      });
      return;
    }

    res.json({ note: result.note, missingBlobIds: result.missingBlobIds });
  });

  router.patch('/:id/summary', async (req, res) => {
    if (req.user.authMode !== 'e2ee') {
      throw badRequest('Encrypted summaries are unavailable for legacy accounts');
    }
    const noteId = noteIdFrom(req);
    const { encryptedSummary, revision } = parseBody(
      z.strictObject({ encryptedSummary: z.unknown(), revision: z.number().int().min(0).optional() }),
      req.body
    );
    const keyId = await currentVaultKeyId(pool, req.user.id);
    const envelope = parseOptionalSummary(encryptedSummary, noteId, 'note summary', keyId);
    if (!envelope) {
      throw badRequest('encryptedSummary is required', 'INVALID_ENVELOPE');
    }
    // `revision`: the summary was derived from that revision's content and
    // must not land on a newer one.
    res.json({ note: await updateSummary(pool, req.user, noteId, envelope, { revision }) });
  });

  router.put('/:id/trash', async (req, res) => {
    res.json({ message: 'Note moved to trash', note: await trashNote(pool, req.user, noteIdFrom(req)) });
  });

  router.put('/:id/restore', async (req, res) => {
    res.json({ note: await restoreNote(pool, req.user, noteIdFrom(req)) });
  });

  router.delete('/:id', async (req, res) => {
    await deleteNotePermanently(pool, req.user, noteIdFrom(req));
    res.json({ message: 'Note deleted' });
  });

  router.get('/:id/revisions', async (req, res) => {
    res.json({ revisions: await listRevisions(pool, req.user, noteIdFrom(req)) });
  });

  router.get('/:id/revisions/:revisionId', async (req, res) => {
    const revisionId = idSchema.parse(req.params.revisionId);
    res.json({ revision: await getRevision(pool, req.user, noteIdFrom(req), revisionId) });
  });

  router.post('/:id/revisions/:revisionId/resolve', async (req, res) => {
    const revisionId = idSchema.parse(req.params.revisionId);
    res.json({ revision: await resolveConflict(pool, req.user, noteIdFrom(req), revisionId) });
  });

  // Key rotation / format upgrade re-encrypts history in place.
  router.put('/:id/revisions/:revisionId', async (req, res) => {
    if (req.user.authMode !== 'e2ee') {
      throw badRequest('Revisions are only kept for encrypted accounts');
    }
    const noteId = noteIdFrom(req);
    const revisionId = idSchema.parse(req.params.revisionId);
    const body = parseBody(reencryptRevisionSchema, req.body);
    const keyId = await currentVaultKeyId(pool, req.user.id);
    const encryptedContent = parseEnvelope(body.encryptedContent, {
      context: CONTEXTS.noteContent(noteId),
      label: 'revision content',
      maxBytes: config.limits.noteMaxBytes,
      keyId,
    });
    await reencryptRevision(pool, req.user, noteId, revisionId, {
      encryptedContent,
      encryptedSummary: parseOptionalSummary(body.encryptedSummary, noteId, 'revision summary', keyId),
      blobIds: body.blobIds,
    });
    res.json({ ok: true });
  });

  return router;
}
