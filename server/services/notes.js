import { lockUserNotes, lockUserNotesShared, withTransaction } from '../db.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';

const SUMMARY_COLUMNS = `
  n.id, n.encrypted_summary, n.revision, n.sync_seq, n.created_at, n.updated_at, n.deleted_at,
  (n.encrypted_content IS NULL AND n.content IS NOT NULL) AS plaintext_residue,
  EXISTS (
    SELECT 1 FROM note_revisions r
    WHERE r.note_id = n.id AND r.kind = 'conflict' AND r.resolved_at IS NULL
  ) AS has_conflict
`;
const FULL_COLUMNS = `${SUMMARY_COLUMNS}, n.encrypted_content, n.content`;
const LEGACY_COLUMNS = 'n.id, n.content, n.revision, n.sync_seq, n.created_at, n.updated_at, n.deleted_at';

export function formatNote(row, authMode, { full = false } = {}) {
  if (authMode !== 'e2ee') {
    return {
      id: row.id,
      content: row.content,
      revision: row.revision,
      sync_seq: row.sync_seq,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    };
  }

  const note = {
    id: row.id,
    encrypted_summary: row.encrypted_summary,
    revision: row.revision,
    sync_seq: row.sync_seq,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    has_conflict: Boolean(row.has_conflict),
    plaintext_residue: Boolean(row.plaintext_residue),
  };
  if (full) {
    note.encrypted_content = row.encrypted_content;
    // Plaintext left behind by 1.x importers or races (DATA-6/DATA-7) is
    // handed to the owner's client once so it can be encrypted and cleared.
    if (row.plaintext_residue) {
      note.content = row.content;
    }
  }
  return note;
}

async function currentSeq(db, userId) {
  const result = await db.query(
    `
      SELECT GREATEST(
        (SELECT MAX(sync_seq) FROM notes WHERE user_id = $1),
        (SELECT MAX(sync_seq) FROM deleted_notes WHERE user_id = $1),
        0
      ) AS seq
    `,
    [userId]
  );
  return result.rows[0].seq;
}

function encodeCursor(row, scope) {
  return Buffer.from(JSON.stringify({ t: scope === 'trash' ? row.deleted_ts : row.updated_ts, i: row.id })).toString(
    'base64url'
  );
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.t === 'string' && Number.isInteger(parsed?.i)) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

// Summary list, optionally keyset-paginated (PERF-3). `seq` is the sync
// position at the time of the read, so a client can continue with /sync.
export async function listNotes(pool, user, { scope = 'active', limit, cursor } = {}) {
  return withTransaction(pool, async (db) => {
    await lockUserNotesShared(db, user.id);
    const seq = await currentSeq(db, user.id);

    const params = [user.id];
    const where = ['n.user_id = $1', 'n.revision > 0'];
    where.push(scope === 'trash' ? 'n.deleted_at IS NOT NULL' : 'n.deleted_at IS NULL');
    const sortColumn = scope === 'trash' ? 'n.deleted_at' : 'n.updated_at';

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (decoded) {
      params.push(decoded.t, decoded.i);
      where.push(`(${sortColumn}, n.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }

    let limitClause = '';
    if (limit) {
      params.push(limit + 1);
      limitClause = `LIMIT $${params.length}`;
    }

    const columns = user.authMode === 'e2ee' ? SUMMARY_COLUMNS : LEGACY_COLUMNS;
    const result = await db.query(
      `
        SELECT ${columns}, n.updated_at::text AS updated_ts, n.deleted_at::text AS deleted_ts
        FROM notes n
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortColumn} DESC, n.id DESC
        ${limitClause}
      `,
      params
    );

    const rows = limit ? result.rows.slice(0, limit) : result.rows;
    const nextCursor = limit && result.rows.length > limit ? encodeCursor(rows[rows.length - 1], scope) : null;
    return { notes: rows.map((row) => formatNote(row, user.authMode)), seq, nextCursor };
  });
}

// Delta sync: everything that changed after `since`, including permanent
// deletions. The shared advisory lock waits for in-flight writes of this
// user, so a sequence number is never observed before a lower one commits.
export async function syncChanges(pool, user, { since, limit }) {
  return withTransaction(pool, async (db) => {
    await lockUserNotesShared(db, user.id);

    const changes = await db.query(
      `
        SELECT kind, id, sync_seq FROM (
          SELECT 'note' AS kind, id, sync_seq FROM notes
          WHERE user_id = $1 AND sync_seq > $2 AND revision > 0
          UNION ALL
          SELECT 'deleted' AS kind, note_id AS id, sync_seq FROM deleted_notes
          WHERE user_id = $1 AND sync_seq > $2
        ) changes
        ORDER BY sync_seq
        LIMIT $3
      `,
      [user.id, since, limit + 1]
    );

    const hasMore = changes.rows.length > limit;
    const page = changes.rows.slice(0, limit);
    const noteIds = page.filter((change) => change.kind === 'note').map((change) => change.id);
    const deleted = page.filter((change) => change.kind === 'deleted').map((change) => change.id);

    let notes = [];
    if (noteIds.length) {
      const columns = user.authMode === 'e2ee' ? SUMMARY_COLUMNS : LEGACY_COLUMNS;
      const result = await db.query(`SELECT ${columns} FROM notes n WHERE n.user_id = $1 AND n.id = ANY($2::int[])`, [
        user.id,
        noteIds,
      ]);
      notes = result.rows.map((row) => formatNote(row, user.authMode));
    }

    const seq = hasMore ? page[page.length - 1].sync_seq : Math.max(since, await currentSeq(db, user.id));
    return { notes, deleted, seq, hasMore };
  });
}

export async function getNote(pool, user, noteId) {
  const columns = user.authMode === 'e2ee' ? FULL_COLUMNS : LEGACY_COLUMNS;
  const result = await pool.query(`SELECT ${columns} FROM notes n WHERE n.id = $1 AND n.user_id = $2`, [
    noteId,
    user.id,
  ]);
  if (!result.rows[0]) {
    throw notFound('Note not found', 'NOTE_NOT_FOUND');
  }
  return formatNote(result.rows[0], user.authMode, { full: true });
}

export async function getNotesBatch(pool, user, ids) {
  const columns = user.authMode === 'e2ee' ? FULL_COLUMNS : LEGACY_COLUMNS;
  const result = await pool.query(
    `SELECT ${columns} FROM notes n WHERE n.user_id = $1 AND n.id = ANY($2::int[]) AND n.revision > 0`,
    [user.id, ids]
  );
  const found = new Set(result.rows.map((row) => row.id));
  return {
    notes: result.rows.map((row) => formatNote(row, user.authMode, { full: true })),
    missing: ids.filter((id) => !found.has(id)),
  };
}

export async function createNote(pool, user, { content, config, createdAt }) {
  return withTransaction(pool, async (db) => {
    await lockUserNotes(db, user.id);

    const count = await db.query('SELECT COUNT(*) AS count FROM notes WHERE user_id = $1', [user.id]);
    if (count.rows[0].count >= config.limits.maxNotesPerUser) {
      throw forbidden('This account has reached its note limit', 'NOTE_LIMIT_REACHED', {
        limit: config.limits.maxNotesPerUser,
      });
    }

    // Encrypted notes start "pending" (revision 0, no content) because their
    // ciphertext is bound to the id; the first save fills them in, and the
    // maintenance job removes pending rows that never got one.
    const result =
      user.authMode === 'e2ee'
        ? await db.query(
            `
              INSERT INTO notes (user_id, revision, blob_refs_known, created_at, updated_at)
              VALUES ($1, 0, TRUE, COALESCE($2::timestamptz, NOW()), COALESCE($2::timestamptz, NOW()))
              RETURNING id
            `,
            [user.id, createdAt ?? null]
          )
        : await db.query(
            `INSERT INTO notes (user_id, content, revision, blob_refs_known) VALUES ($1, $2, 1, TRUE) RETURNING id`,
            [user.id, JSON.stringify(content)]
          );

    const columns = user.authMode === 'e2ee' ? FULL_COLUMNS : LEGACY_COLUMNS;
    const created = await db.query(`SELECT ${columns} FROM notes n WHERE n.id = $1`, [result.rows[0].id]);
    return formatNote(created.rows[0], user.authMode, { full: true });
  });
}

async function ownedBlobIds(db, userId, blobIds) {
  const unique = [...new Set(blobIds)];
  if (!unique.length) {
    return { owned: [], missing: [] };
  }
  const result = await db.query('SELECT id FROM blobs WHERE user_id = $1 AND id = ANY($2::int[])', [userId, unique]);
  const owned = result.rows.map((row) => row.id);
  const ownedSet = new Set(owned);
  return { owned, missing: unique.filter((id) => !ownedSet.has(id)) };
}

async function replaceNoteRefs(db, noteId, blobIds) {
  await db.query('DELETE FROM blob_refs WHERE note_id = $1 AND NOT (blob_id = ANY($2::int[]))', [noteId, blobIds]);
  if (blobIds.length) {
    await db.query(
      'INSERT INTO blob_refs (note_id, blob_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING',
      [noteId, blobIds]
    );
    // A reference resurrects a blob that was waiting for garbage collection.
    await db.query(
      'UPDATE blobs SET unreferenced_since = NULL WHERE id = ANY($1::int[]) AND unreferenced_since IS NOT NULL',
      [blobIds]
    );
  }
}

async function storeConflict(db, { user, sessionId, noteId, baseRevision, envelope, summary, blobIds, reason }) {
  let ids = [];
  let refsKnown = false;
  if (Array.isArray(blobIds)) {
    ids = (await ownedBlobIds(db, user.id, blobIds)).owned;
    refsKnown = true;
  }

  // One open conflict per note and session: a client that keeps retrying
  // (e.g. a pre-upgrade tab autosaving) updates its row instead of piling up.
  const existing = await db.query(
    `
      SELECT id FROM note_revisions
      WHERE note_id = $1 AND kind = 'conflict' AND resolved_at IS NULL AND session_id IS NOT DISTINCT FROM $2
      ORDER BY created_at DESC LIMIT 1
    `,
    [noteId, sessionId]
  );

  const values = [
    baseRevision ?? 0,
    JSON.stringify(envelope),
    summary ? JSON.stringify(summary) : null,
    ids,
    refsKnown,
    reason,
  ];

  if (existing.rows[0]) {
    await db.query(
      `
        UPDATE note_revisions
        SET revision = $1, encrypted_content = $2, encrypted_summary = $3, blob_ids = $4,
            blob_refs_known = $5, reason = $6, updated_at = NOW()
        WHERE id = $7
      `,
      [...values, existing.rows[0].id]
    );
    return existing.rows[0].id;
  }

  const inserted = await db.query(
    `
      INSERT INTO note_revisions
        (revision, encrypted_content, encrypted_summary, blob_ids, blob_refs_known, reason, note_id, user_id, kind, session_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'conflict', $9)
      RETURNING id
    `,
    [...values, noteId, user.id, sessionId]
  );
  return inserted.rows[0].id;
}

async function snapshotCurrentVersion(db, noteId, userId, reason) {
  await db.query(
    `
      INSERT INTO note_revisions
        (note_id, user_id, kind, reason, revision, encrypted_content, encrypted_summary,
         blob_ids, blob_refs_known, session_id, created_at)
      SELECT n.id, n.user_id, 'snapshot', $3, n.revision, n.encrypted_content, n.encrypted_summary,
             COALESCE((SELECT array_agg(r.blob_id ORDER BY r.blob_id) FROM blob_refs r WHERE r.note_id = n.id), '{}'),
             n.blob_refs_known, n.last_writer_session, n.updated_at
      FROM notes n
      WHERE n.id = $1 AND n.user_id = $2 AND n.encrypted_content IS NOT NULL
    `,
    [noteId, userId, reason]
  );
}

async function pruneRevisions(db, noteId, keep) {
  await db.query(
    `
      DELETE FROM note_revisions WHERE id IN (
        SELECT id FROM note_revisions
        WHERE note_id = $1 AND (kind = 'snapshot' OR resolved_at IS NOT NULL)
        ORDER BY created_at DESC, id DESC
        OFFSET $2
      )
    `,
    [noteId, keep]
  );
}

const FORCED_SNAPSHOT_REASONS = new Set(['restore', 'conflict-resolution', 'import']);

/**
 * Saves a new encrypted version of a note (DATA-1, DATA-3, DATA-4).
 *
 * The write only succeeds when `baseRevision` matches the stored revision.
 * Every rejected write is kept as a `conflict` revision, so an edit made on a
 * stale tab, a second device or a pre-upgrade client is never discarded; the
 * response tells the client why and includes the current version.
 *
 * Returns { status: 'saved', note, missingBlobIds } or
 *         { status: 'conflict', code, message, note, conflictRevisionId }.
 */
export async function saveEncryptedNote(pool, config, user, sessionId, noteId, input) {
  const { baseRevision, encryptedContent, encryptedSummary, blobIds, reason, updatedAt } = input;

  return withTransaction(pool, async (db) => {
    await lockUserNotes(db, user.id);

    const currentResult = await db.query(
      `
        SELECT n.id, n.revision, n.deleted_at, n.encrypted_content IS NOT NULL AS has_ciphertext,
               n.last_writer_session, n.last_snapshot_at,
               u.vault_key_id, u.min_envelope_version
        FROM notes n JOIN users u ON u.id = n.user_id
        WHERE n.id = $1 AND n.user_id = $2
        FOR UPDATE OF n
      `,
      [noteId, user.id]
    );
    const current = currentResult.rows[0];

    if (!current) {
      const tombstone = await db.query('SELECT 1 FROM deleted_notes WHERE note_id = $1 AND user_id = $2', [
        noteId,
        user.id,
      ]);
      throw tombstone.rows.length
        ? notFound('This note was permanently deleted on another device', 'NOTE_DELETED')
        : notFound('Note not found', 'NOTE_NOT_FOUND');
    }

    async function reject(code, message, conflictReason) {
      const conflictRevisionId = await storeConflict(db, {
        user,
        sessionId,
        noteId,
        baseRevision,
        envelope: encryptedContent,
        summary: encryptedSummary,
        blobIds,
        reason: conflictReason,
      });
      const latest = await db.query(`SELECT ${FULL_COLUMNS} FROM notes n WHERE n.id = $1`, [noteId]);
      return {
        status: 'conflict',
        code,
        message,
        conflictRevisionId,
        note: formatNote(latest.rows[0], 'e2ee', { full: true }),
      };
    }

    if (encryptedContent.version < current.min_envelope_version) {
      return reject('CLIENT_OUTDATED', 'This client uses an outdated encryption format. Reload the app.', 'outdated-format');
    }
    const staleKey = (envelope) =>
      envelope?.version === 3 && current.vault_key_id && envelope.keyId !== current.vault_key_id;
    if (staleKey(encryptedContent) || staleKey(encryptedSummary)) {
      return reject('KEY_ROTATED', 'The encryption key changed on another device. Unlock again to continue.', 'key-rotated');
    }
    // Re-encryption (format upgrade, key rotation) must also reach notes in
    // the trash; it leaves them there.
    if (current.deleted_at && reason !== 'reencrypt') {
      return reject('NOTE_TRASHED', 'This note was moved to the trash on another device.', 'trashed');
    }

    let base = baseRevision;
    if (base === undefined) {
      // Pre-upgrade clients send no revision. That is only safe for the very
      // first save of a freshly created note.
      if (current.revision !== 0) {
        return reject('CLIENT_OUTDATED', 'This app version is out of date. Reload to keep editing.', 'missing-revision');
      }
      base = 0;
    }
    if (base !== current.revision) {
      return reject('REVISION_CONFLICT', 'This note was changed on another device.', 'stale-revision');
    }
    if (encryptedContent.version === 3 && encryptedContent.revision !== base + 1) {
      return reject('REVISION_CONFLICT', 'The encrypted content is bound to a different revision.', 'stale-revision');
    }

    const reencrypt = reason === 'reencrypt';
    const now = Date.now();
    const intervalElapsed =
      !current.last_snapshot_at || now - current.last_snapshot_at.getTime() >= config.retention.snapshotIntervalMs;
    const writerChanged = Boolean(current.last_writer_session) && current.last_writer_session !== sessionId;
    const takeSnapshot =
      !reencrypt &&
      current.revision > 0 &&
      current.has_ciphertext &&
      (FORCED_SNAPSHOT_REASONS.has(reason) || intervalElapsed || writerChanged);

    if (takeSnapshot) {
      const snapshotReason = FORCED_SNAPSHOT_REASONS.has(reason) ? reason : writerChanged ? 'device-switch' : 'interval';
      await snapshotCurrentVersion(db, noteId, user.id, snapshotReason);
    }

    let missingBlobIds = [];
    let refsKnown = false;
    if (Array.isArray(blobIds)) {
      const { owned, missing } = await ownedBlobIds(db, user.id, blobIds);
      await replaceNoteRefs(db, noteId, owned);
      missingBlobIds = missing;
      refsKnown = true;
    }

    const updated = await db.query(
      `
        UPDATE notes n
        SET content = NULL,
            encrypted_content = $3,
            encrypted_summary = COALESCE($4::jsonb, n.encrypted_summary),
            revision = n.revision + 1,
            updated_at = CASE WHEN $5 THEN n.updated_at ELSE COALESCE($9::timestamptz, NOW()) END,
            last_writer_session = CASE WHEN $5 THEN n.last_writer_session ELSE $6 END,
            last_snapshot_at = CASE WHEN $7 THEN NOW() ELSE n.last_snapshot_at END,
            blob_refs_known = CASE WHEN $8 THEN TRUE WHEN $5 THEN n.blob_refs_known ELSE FALSE END
        WHERE n.id = $1 AND n.user_id = $2
        RETURNING ${FULL_COLUMNS}
      `,
      [
        noteId,
        user.id,
        JSON.stringify(encryptedContent),
        encryptedSummary ? JSON.stringify(encryptedSummary) : null,
        reencrypt,
        sessionId,
        takeSnapshot,
        refsKnown,
        updatedAt ?? null,
      ]
    );

    if (takeSnapshot) {
      await pruneRevisions(db, noteId, config.limits.maxRevisionsPerNote);
    }

    return {
      status: 'saved',
      note: formatNote(updated.rows[0], 'e2ee'),
      missingBlobIds,
    };
  });
}

// Legacy (pre-encryption) accounts. The mode check and the write share one
// transaction behind the user's note lock and a KEY SHARE lock on the user
// row, so a write racing the e2ee migration waits for it and is then refused
// instead of storing plaintext in an encrypted account (DATA-7).
export async function saveLegacyNote(pool, user, noteId, { baseRevision, content }) {
  return withTransaction(pool, async (db) => {
    await lockUserNotes(db, user.id);
    const mode = await db.query('SELECT auth_mode FROM users WHERE id = $1 FOR KEY SHARE', [user.id]);
    if (mode.rows[0]?.auth_mode !== 'legacy') {
      throw conflict(
        'This account was upgraded to end-to-end encryption. Reload the app to continue.',
        'CLIENT_OUTDATED'
      );
    }

    const current = await db.query(
      'SELECT id, revision, deleted_at FROM notes WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [noteId, user.id]
    );
    const note = current.rows[0];
    if (!note) {
      throw notFound('Note not found', 'NOTE_NOT_FOUND');
    }
    if (note.deleted_at) {
      throw conflict('This note was moved to the trash on another device.', 'NOTE_TRASHED');
    }
    if (baseRevision !== undefined && baseRevision !== note.revision) {
      const latest = await db.query(`SELECT ${LEGACY_COLUMNS} FROM notes n WHERE n.id = $1`, [noteId]);
      throw conflict('This note was changed on another device.', 'REVISION_CONFLICT', {
        note: formatNote(latest.rows[0], 'legacy'),
      });
    }

    const updated = await db.query(
      `
        UPDATE notes n SET content = $3, revision = n.revision + 1, updated_at = NOW()
        WHERE n.id = $1 AND n.user_id = $2
        RETURNING ${LEGACY_COLUMNS}
      `,
      [noteId, user.id, JSON.stringify(content)]
    );
    return formatNote(updated.rows[0], 'legacy');
  });
}

export async function updateSummary(pool, user, noteId, encryptedSummary, { revision } = {}) {
  return withTransaction(pool, async (db) => {
    await lockUserNotes(db, user.id);
    const result = await db.query(
      `UPDATE notes n SET encrypted_summary = $3
        WHERE n.id = $1 AND n.user_id = $2 AND ($4::bigint IS NULL OR n.revision = $4)
        RETURNING ${SUMMARY_COLUMNS}`,
      [noteId, user.id, JSON.stringify(encryptedSummary), revision ?? null]
    );
    if (!result.rows[0]) {
      const exists = await db.query('SELECT 1 FROM notes WHERE id = $1 AND user_id = $2', [noteId, user.id]);
      if (exists.rows[0]) {
        throw conflict('The note changed since this summary was made', 'SUMMARY_STALE');
      }
      throw notFound('Note not found', 'NOTE_NOT_FOUND');
    }
    return formatNote(result.rows[0], 'e2ee');
  });
}

export async function trashNote(pool, user, noteId) {
  return withTransaction(pool, async (db) => {
    await lockUserNotes(db, user.id);
    const columns = user.authMode === 'e2ee' ? SUMMARY_COLUMNS : LEGACY_COLUMNS;
    const result = await db.query(
      `
        UPDATE notes n SET deleted_at = NOW()
        WHERE n.id = $1 AND n.user_id = $2 AND n.deleted_at IS NULL
        RETURNING ${columns}
      `,
      [noteId, user.id]
    );
    if (result.rows[0]) {
      return formatNote(result.rows[0], user.authMode);
    }
    const existing = await db.query(`SELECT ${columns} FROM notes n WHERE n.id = $1 AND n.user_id = $2`, [
      noteId,
      user.id,
    ]);
    if (!existing.rows[0]) {
      throw notFound('Note not found', 'NOTE_NOT_FOUND');
    }
    return formatNote(existing.rows[0], user.authMode);
  });
}

export async function restoreNote(pool, user, noteId) {
  return withTransaction(pool, async (db) => {
    await lockUserNotes(db, user.id);
    const columns = user.authMode === 'e2ee' ? SUMMARY_COLUMNS : LEGACY_COLUMNS;
    const result = await db.query(
      `
        UPDATE notes n SET deleted_at = NULL, updated_at = NOW()
        WHERE n.id = $1 AND n.user_id = $2 AND n.deleted_at IS NOT NULL
        RETURNING ${columns}
      `,
      [noteId, user.id]
    );
    if (!result.rows[0]) {
      throw notFound('Note not found in the trash', 'NOTE_NOT_FOUND');
    }
    return formatNote(result.rows[0], user.authMode);
  });
}

// Permanent deletion requires the note to be in the trash first, so a client
// bug or a single stray request cannot destroy an active note. Revisions and
// blob references cascade; unreferenced blobs are garbage-collected later.
export async function deleteNotePermanently(pool, user, noteId) {
  return withTransaction(pool, async (db) => {
    await lockUserNotes(db, user.id);
    const existing = await db.query('SELECT deleted_at FROM notes WHERE id = $1 AND user_id = $2 FOR UPDATE', [
      noteId,
      user.id,
    ]);
    if (!existing.rows[0]) {
      throw notFound('Note not found', 'NOTE_NOT_FOUND');
    }
    if (!existing.rows[0].deleted_at) {
      throw conflict('Move the note to the trash before deleting it permanently', 'NOTE_NOT_TRASHED');
    }
    await db.query('DELETE FROM notes WHERE id = $1 AND user_id = $2', [noteId, user.id]);
  });
}

async function assertNoteOwned(db, user, noteId) {
  const result = await db.query('SELECT 1 FROM notes WHERE id = $1 AND user_id = $2', [noteId, user.id]);
  if (!result.rows.length) {
    throw notFound('Note not found', 'NOTE_NOT_FOUND');
  }
}

export async function listRevisions(pool, user, noteId) {
  await assertNoteOwned(pool, user, noteId);
  const result = await pool.query(
    `
      SELECT id, kind, reason, revision, created_at, updated_at, resolved_at,
             octet_length(encrypted_content::text) AS size,
             encrypted_content->>'keyId' AS key_id,
             (encrypted_content->>'version')::int AS envelope_version
      FROM note_revisions
      WHERE note_id = $1 AND user_id = $2
      ORDER BY created_at DESC, id DESC
    `,
    [noteId, user.id]
  );
  return result.rows;
}

export async function getRevision(pool, user, noteId, revisionId) {
  const result = await pool.query(
    `
      SELECT id, note_id, kind, reason, revision, encrypted_content, encrypted_summary, blob_ids,
             created_at, updated_at, resolved_at
      FROM note_revisions
      WHERE id = $1 AND note_id = $2 AND user_id = $3
    `,
    [revisionId, noteId, user.id]
  );
  if (!result.rows[0]) {
    throw notFound('Revision not found', 'REVISION_NOT_FOUND');
  }
  return result.rows[0];
}

export async function resolveConflict(pool, user, noteId, revisionId) {
  const result = await pool.query(
    `
      UPDATE note_revisions SET resolved_at = COALESCE(resolved_at, NOW())
      WHERE id = $1 AND note_id = $2 AND user_id = $3 AND kind = 'conflict'
      RETURNING id, resolved_at
    `,
    [revisionId, noteId, user.id]
  );
  if (!result.rows[0]) {
    throw notFound('Conflict not found', 'REVISION_NOT_FOUND');
  }
  return result.rows[0];
}

// Used by key rotation / format upgrade: same plaintext, new envelope.
export async function reencryptRevision(pool, user, noteId, revisionId, { encryptedContent, encryptedSummary, blobIds }) {
  return withTransaction(pool, async (db) => {
    await lockUserNotes(db, user.id);
    let ids = null;
    if (Array.isArray(blobIds)) {
      ids = (await ownedBlobIds(db, user.id, blobIds)).owned;
    }
    const result = await db.query(
      `
        UPDATE note_revisions
        SET encrypted_content = $4,
            encrypted_summary = COALESCE($5::jsonb, encrypted_summary),
            blob_ids = COALESCE($6::int[], blob_ids),
            blob_refs_known = CASE WHEN $6::int[] IS NULL THEN blob_refs_known ELSE TRUE END,
            updated_at = NOW()
        WHERE id = $1 AND note_id = $2 AND user_id = $3
        RETURNING id
      `,
      [
        revisionId,
        noteId,
        user.id,
        JSON.stringify(encryptedContent),
        encryptedSummary ? JSON.stringify(encryptedSummary) : null,
        ids,
      ]
    );
    if (!result.rows[0]) {
      throw notFound('Revision not found', 'REVISION_NOT_FOUND');
    }
  });
}
