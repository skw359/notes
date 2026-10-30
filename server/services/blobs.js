import { lockUserNotes, withTransaction } from '../db.js';
import { BlobTooLargeError } from '../lib/blobStorage.js';
import { badRequest, conflict, notFound, payloadTooLarge } from '../lib/errors.js';

// A blob is in use when any current note version, any kept revision, the
// profile, or a pending legacy migration references it.
const BLOB_REFERENCED_SQL = `(
  EXISTS (SELECT 1 FROM blob_refs r WHERE r.blob_id = b.id)
  OR EXISTS (SELECT 1 FROM note_revisions nr WHERE nr.user_id = b.user_id AND b.id = ANY(nr.blob_ids))
  OR EXISTS (SELECT 1 FROM users u WHERE u.id = b.user_id AND u.profile_blob_id = b.id)
  OR EXISTS (SELECT 1 FROM migration_staging s WHERE s.user_id = b.user_id AND b.id = ANY(s.blob_ids))
)`;

export async function storageUsage(db, userId) {
  const result = await db.query(
    'SELECT COALESCE(SUM(byte_length), 0)::bigint AS bytes, COUNT(*)::int AS count FROM blobs WHERE user_id = $1',
    [userId]
  );
  return result.rows[0];
}

export async function gcStatus(db, userId) {
  const result = await db.query(
    `
      SELECT
        u.profile_ref_known,
        (SELECT COUNT(*)::int FROM notes n WHERE n.user_id = u.id AND NOT n.blob_refs_known) AS notes_unknown,
        (SELECT COUNT(*)::int FROM note_revisions r WHERE r.user_id = u.id AND NOT r.blob_refs_known) AS revisions_unknown
      FROM users u WHERE u.id = $1
    `,
    [userId]
  );
  const row = result.rows[0];
  return {
    profileRefKnown: row.profile_ref_known,
    notesWithUnknownRefs: row.notes_unknown,
    revisionsWithUnknownRefs: row.revisions_unknown,
    enabled: row.profile_ref_known && row.notes_unknown === 0 && row.revisions_unknown === 0,
  };
}

/**
 * Streams an encrypted upload to a temp file, then inserts the row and moves
 * the file into place in one transaction, so a failed write can no longer
 * leave a row without a file (SEC-7). Size and quota are enforced before and
 * while reading the body.
 */
export async function uploadBlob({ pool, storage, config, user, req, meta }) {
  const { maxBlobBytes, userQuotaBytes } = config.limits;
  const declaredLength = Number(req.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBlobBytes) {
    throw payloadTooLarge('This file is larger than the upload limit', 'PAYLOAD_TOO_LARGE', { limit: maxBlobBytes });
  }

  const usage = userQuotaBytes ? await storageUsage(pool, user.id) : null;
  if (usage && Number.isFinite(declaredLength) && usage.bytes + declaredLength > userQuotaBytes) {
    throw payloadTooLarge('Your storage quota is full', 'QUOTA_EXCEEDED', { quota: userQuotaBytes, used: usage.bytes });
  }

  let received;
  try {
    received = await storage.receive(req, { maxBytes: maxBlobBytes });
  } catch (error) {
    if (error instanceof BlobTooLargeError) {
      throw payloadTooLarge('This file is larger than the upload limit', 'PAYLOAD_TOO_LARGE', { limit: maxBlobBytes });
    }
    throw error;
  }

  try {
    if (received.size === 0) {
      throw badRequest('The upload is empty', 'EMPTY_UPLOAD');
    }
    if (usage && usage.bytes + received.size > userQuotaBytes) {
      throw payloadTooLarge('Your storage quota is full', 'QUOTA_EXCEEDED', { quota: userQuotaBytes, used: usage.bytes });
    }

    const storageKey = storage.newKey(user.id);
    return await withTransaction(pool, async (db) => {
      const inserted = await db.query(
        `
          INSERT INTO blobs (
            user_id, kind, mime_type, byte_length, storage_path, storage_key,
            envelope_iv, envelope_algorithm, envelope_version, key_id
          )
          VALUES ($1, 'blob', 'application/octet-stream', $2, $3, $4, $5, 'AES-256-GCM', $6, $7)
          RETURNING id, byte_length, envelope_version, key_id, created_at
        `,
        [
          user.id,
          received.size,
          // Absolute path kept only for pre-2.0 rollbacks; 2.x reads storage_key.
          storage.resolve(storageKey),
          storageKey,
          meta.iv ?? null,
          meta.version,
          meta.keyId ?? null,
        ]
      );
      const blob = inserted.rows[0];

      if (meta.replaces) {
        await db.query('UPDATE blobs SET replaced_by = $1 WHERE id = $2 AND user_id = $3', [
          blob.id,
          meta.replaces,
          user.id,
        ]);
      }

      await storage.commit(received.tempPath, storageKey);
      return blob;
    });
  } catch (error) {
    await storage.discard(received.tempPath);
    throw error;
  }
}

export async function findBlob(pool, user, blobId) {
  const result = await pool.query(
    `
      SELECT id, storage_key, byte_length, envelope_iv, envelope_algorithm, envelope_version, key_id
      FROM blobs WHERE id = $1 AND user_id = $2
    `,
    [blobId, user.id]
  );
  if (!result.rows[0]) {
    throw notFound('Blob not found', 'BLOB_NOT_FOUND');
  }
  return result.rows[0];
}

// Clients no longer delete blobs (DATA-4). A deletion request only marks an
// unreferenced blob; the collector removes it after the grace period, and any
// new reference before then cancels the deletion.
export async function requestBlobDeletion(pool, user, blobId) {
  return withTransaction(pool, async (db) => {
    await lockUserNotes(db, user.id);
    const result = await db.query(
      `SELECT b.id, ${BLOB_REFERENCED_SQL} AS referenced FROM blobs b WHERE b.id = $1 AND b.user_id = $2 FOR UPDATE`,
      [blobId, user.id]
    );
    const blob = result.rows[0];
    if (!blob) {
      throw notFound('Blob not found', 'BLOB_NOT_FOUND');
    }
    if (blob.referenced) {
      throw conflict('This file is still used by a note', 'BLOB_IN_USE');
    }
    await db.query(
      'UPDATE blobs SET unreferenced_since = COALESCE(unreferenced_since, NOW()) WHERE id = $1',
      [blobId]
    );
  });
}

async function ownedIds(db, userId, ids) {
  if (!ids.length) {
    return [];
  }
  const result = await db.query('SELECT id FROM blobs WHERE user_id = $1 AND id = ANY($2::int[])', [userId, ids]);
  return result.rows.map((row) => row.id);
}

/**
 * Records which blobs existing notes, revisions and the profile reference.
 * Notes saved before 2.0 have unknown references; until every one of a
 * user's records is known, the collector deletes nothing for that user.
 * A note is only updated when its revision still matches what the client
 * scanned, so a concurrent edit cannot be overwritten with stale refs.
 */
export async function reconcileRefs(pool, user, { notes = [], revisions = [], profile }) {
  return withTransaction(pool, async (db) => {
    await lockUserNotes(db, user.id);

    let notesUpdated = 0;
    const notesSkipped = [];
    for (const entry of notes) {
      const updated = await db.query(
        'UPDATE notes SET blob_refs_known = TRUE WHERE id = $1 AND user_id = $2 AND revision = $3 RETURNING id',
        [entry.id, user.id, entry.revision]
      );
      if (!updated.rows.length) {
        notesSkipped.push(entry.id);
        continue;
      }
      const owned = await ownedIds(db, user.id, [...new Set(entry.blobIds)]);
      await db.query('DELETE FROM blob_refs WHERE note_id = $1 AND NOT (blob_id = ANY($2::int[]))', [entry.id, owned]);
      if (owned.length) {
        await db.query(
          'INSERT INTO blob_refs (note_id, blob_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING',
          [entry.id, owned]
        );
      }
      notesUpdated += 1;
    }

    let revisionsUpdated = 0;
    for (const entry of revisions) {
      const owned = await ownedIds(db, user.id, [...new Set(entry.blobIds)]);
      const updated = await db.query(
        'UPDATE note_revisions SET blob_ids = $3, blob_refs_known = TRUE WHERE id = $1 AND user_id = $2',
        [entry.id, user.id, owned]
      );
      revisionsUpdated += updated.rowCount;
    }

    if (profile !== undefined) {
      const blobId = profile.blobId ?? null;
      const owned = blobId === null ? [] : await ownedIds(db, user.id, [blobId]);
      // Only fills in an unknown reference, and only from the profile version
      // the client decrypted: a concurrent profile change must never be
      // replaced by a stale picture reference (the new picture would become
      // collectable).
      await db.query(
        `UPDATE users SET profile_blob_id = $2, profile_ref_known = TRUE
          WHERE id = $1 AND NOT profile_ref_known AND encrypted_profile->>'iv' IS NOT DISTINCT FROM $3`,
        [user.id, owned[0] ?? null, profile.profileIv]
      );
    }

    // Anything referenced again must not be collected.
    await db.query(
      `UPDATE blobs b SET unreferenced_since = NULL
       WHERE b.user_id = $1 AND b.unreferenced_since IS NOT NULL AND ${BLOB_REFERENCED_SQL}`,
      [user.id]
    );

    return { notesUpdated, notesSkipped, revisionsUpdated, gc: await gcStatus(db, user.id) };
  });
}

/**
 * DATA-4 / SEC-7: server-side garbage collection with a grace period.
 * Only users whose references are fully known are processed. A blob is first
 * marked unreferenced, then deleted once it has stayed unreferenced for the
 * grace period; files go to the deleted-files area for a final sweep.
 */
export async function collectGarbageBlobs({ pool, storage, config, log = console }) {
  const eligible = await pool.query(`
    SELECT u.id FROM users u
    WHERE u.profile_ref_known
      AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.user_id = u.id AND NOT n.blob_refs_known)
      AND NOT EXISTS (SELECT 1 FROM note_revisions r WHERE r.user_id = u.id AND NOT r.blob_refs_known)
      AND EXISTS (SELECT 1 FROM blobs b WHERE b.user_id = u.id)
  `);

  const graceSeconds = Math.floor(config.retention.blobGraceMs / 1000);
  let marked = 0;
  let deleted = 0;

  for (const { id: userId } of eligible.rows) {
    const keys = await withTransaction(pool, async (db) => {
      await lockUserNotes(db, userId);
      const markResult = await db.query(
        `
          UPDATE blobs b SET unreferenced_since = NOW()
          WHERE b.user_id = $1 AND b.unreferenced_since IS NULL
            AND b.created_at < NOW() - INTERVAL '1 hour'
            AND NOT ${BLOB_REFERENCED_SQL}
        `,
        [userId]
      );
      marked += markResult.rowCount;

      await db.query(
        `UPDATE blobs b SET unreferenced_since = NULL
         WHERE b.user_id = $1 AND b.unreferenced_since IS NOT NULL AND ${BLOB_REFERENCED_SQL}`,
        [userId]
      );

      const removed = await db.query(
        `
          DELETE FROM blobs b
          WHERE b.user_id = $1
            AND b.unreferenced_since < NOW() - make_interval(secs => $2)
            AND NOT ${BLOB_REFERENCED_SQL}
          RETURNING storage_key
        `,
        [userId, graceSeconds]
      );
      return removed.rows.map((row) => row.storage_key).filter(Boolean);
    });

    for (const key of keys) {
      try {
        await storage.moveToDeleted(key);
      } catch (error) {
        log.error?.(`[gc] could not move blob file ${key}: ${error.message}`);
      }
    }
    deleted += keys.length;
  }

  return { usersProcessed: eligible.rows.length, marked, deleted };
}
