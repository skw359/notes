import express, { Router } from 'express';
import { z } from 'zod';
import { lockUserNotes, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import {
  CONTEXTS,
  keyIdSchema,
  kdfParamsSchema,
  parseBody,
  parseEnvelope,
  parseWrappedKey,
  saltSchema,
  verifierSchema,
  WRAPPED_KEY_BYTES,
} from '../lib/validation.js';
import { buildE2EEAuthResponse, findUserById, requireCurrentCredentials } from '../services/accounts.js';

const startRotationSchema = z.strictObject({
  currentAuthSecret: verifierSchema,
  newKeyId: keyIdSchema,
  authSalt: saltSchema,
  kdfParams: kdfParamsSchema,
  authVerifier: verifierSchema,
  wrappedVaultKey: z.unknown(),
  recoveryVerifier: verifierSchema,
  wrappedVaultKeyRecovery: z.unknown(),
  // Every previous key, wrapped under the new key, so not-yet-re-encrypted
  // data stays readable on every device until the rotation completes.
  keyring: z.record(keyIdSchema, z.unknown()),
});

// Items that still need re-encryption: anything not a v3 envelope under the
// current key. Notes that only have a summary (no content) count via the
// summary alone.
function pendingNotesSql(alias = 'n') {
  return `(
    (${alias}.encrypted_content IS NOT NULL AND (
      (${alias}.encrypted_content->>'version')::int < 3
      OR ${alias}.encrypted_content->>'keyId' IS DISTINCT FROM $2))
    OR (${alias}.encrypted_content IS NULL AND ${alias}.content IS NOT NULL)
    OR (${alias}.encrypted_summary IS NOT NULL AND (
      (${alias}.encrypted_summary->>'version')::int < 3
      OR ${alias}.encrypted_summary->>'keyId' IS DISTINCT FROM $2))
  )`;
}

const PENDING_REVISIONS_SQL = `(
  (r.encrypted_content->>'version')::int < 3
  OR r.encrypted_content->>'keyId' IS DISTINCT FROM $2
  OR (r.encrypted_summary IS NOT NULL AND (
    (r.encrypted_summary->>'version')::int < 3 OR r.encrypted_summary->>'keyId' IS DISTINCT FROM $2))
)`;

const REFERENCED_BLOB_SQL = `(
  EXISTS (SELECT 1 FROM blob_refs br WHERE br.blob_id = b.id)
  OR EXISTS (SELECT 1 FROM note_revisions nr WHERE nr.user_id = b.user_id AND b.id = ANY(nr.blob_ids))
  OR EXISTS (SELECT 1 FROM users u WHERE u.id = b.user_id AND u.profile_blob_id = b.id)
)`;

const PENDING_BLOBS_SQL = `(b.envelope_version < 3 OR b.key_id IS DISTINCT FROM $2) AND ${REFERENCED_BLOB_SQL}`;

async function pendingSummary(db, user) {
  const keyId = user.vault_key_id;
  const params = [user.id, keyId];
  // Sequential: `db` may be a single transaction client.
  const notes = await db.query(
    `SELECT COUNT(*)::int AS count FROM notes n WHERE n.user_id = $1 AND n.revision > 0 AND ${pendingNotesSql()}`,
    params
  );
  const revisions = await db.query(
    `SELECT COUNT(*)::int AS count FROM note_revisions r WHERE r.user_id = $1 AND ${PENDING_REVISIONS_SQL}`,
    params
  );
  const blobs = await db.query(`SELECT COUNT(*)::int AS count FROM blobs b WHERE b.user_id = $1 AND ${PENDING_BLOBS_SQL}`, params);
  const refs = await db.query(
    `
      SELECT
        (SELECT COUNT(*)::int FROM notes WHERE user_id = $1 AND NOT blob_refs_known) AS notes_unknown,
        (SELECT COUNT(*)::int FROM note_revisions WHERE user_id = $1 AND NOT blob_refs_known) AS revisions_unknown
    `,
    [user.id]
  );
  const profile = user.encrypted_profile;
  const profilePending = Boolean(profile) && (Number(profile.version) < 3 || profile.keyId !== keyId);
  return {
    notes: notes.rows[0].count,
    revisions: revisions.rows[0].count,
    blobs: blobs.rows[0].count,
    profile: profilePending,
    notesWithUnknownRefs: refs.rows[0].notes_unknown,
    revisionsWithUnknownRefs: refs.rows[0].revisions_unknown,
    profileRefKnown: Boolean(user.profile_ref_known),
  };
}

function isComplete(pending) {
  return (
    pending.notes === 0 &&
    pending.revisions === 0 &&
    pending.blobs === 0 &&
    !pending.profile &&
    pending.notesWithUnknownRefs === 0 &&
    pending.revisionsWithUnknownRefs === 0 &&
    pending.profileRefKnown
  );
}

export function createVaultRouter(ctx) {
  const { pool, sessions, limiters, requireSession, config } = ctx;
  const router = Router();
  const json = express.json({ limit: config.limits.authBodyBytes });

  router.use(requireSession);
  router.use((req, res, next) => {
    if (req.user.authMode !== 'e2ee') {
      throw badRequest('This account is not end-to-end encrypted yet', 'E2EE_REQUIRED');
    }
    next();
  });

  // The key id is a fingerprint the client derives from the vault key, so
  // every client computes the same one. Recorded the first time a client
  // unlocks an account created before key ids existed.
  router.post('/key-id', limiters.api, json, async (req, res) => {
    const { keyId } = parseBody(z.strictObject({ keyId: keyIdSchema }), req.body);
    const result = await pool.query(
      `
        UPDATE users SET vault_key_id = $2
        WHERE id = $1 AND (vault_key_id IS NULL OR vault_key_id = $2)
        RETURNING vault_key_id
      `,
      [req.user.id, keyId]
    );
    if (!result.rows.length) {
      throw conflict('This account already uses a different vault key', 'KEY_MISMATCH');
    }
    res.json({ vaultKeyId: result.rows[0].vault_key_id });
  });

  router.get('/status', limiters.api, async (req, res) => {
    const user = await findUserById(pool, req.user.id);
    const pending = await pendingSummary(pool, user);
    res.json({
      vaultKeyId: user.vault_key_id,
      previousKeyIds: Object.keys(user.vault_keyring || {}),
      rotationStartedAt: user.rotation_started_at,
      minEnvelopeVersion: user.min_envelope_version,
      pending,
      complete: isComplete(pending),
    });
  });

  router.get('/pending', limiters.api, async (req, res) => {
    const { type, limit, after } = z
      .object({
        type: z.enum(['notes', 'revisions', 'blobs']),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        // Keyset paging by id.
        after: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const user = await findUserById(pool, req.user.id);
    const params = [user.id, user.vault_key_id, limit, after];

    let rows;
    if (type === 'notes') {
      rows = (
        await pool.query(
          `SELECT n.id FROM notes n WHERE n.user_id = $1 AND n.id > $4 AND n.revision > 0 AND ${pendingNotesSql()} ORDER BY n.id LIMIT $3`,
          params
        )
      ).rows;
    } else if (type === 'revisions') {
      rows = (
        await pool.query(
          `SELECT r.id, r.note_id FROM note_revisions r WHERE r.user_id = $1 AND r.id > $4 AND ${PENDING_REVISIONS_SQL} ORDER BY r.id LIMIT $3`,
          params
        )
      ).rows;
    } else {
      rows = (
        await pool.query(
          `
            SELECT b.id, b.envelope_version, b.key_id, b.replaced_by
            FROM blobs b WHERE b.user_id = $1 AND b.id > $4 AND ${PENDING_BLOBS_SQL}
            ORDER BY b.id LIMIT $3
          `,
          params
        )
      ).rows;
    }
    res.json({ items: rows, next: rows.length === limit ? rows[rows.length - 1].id : null });
  });

  // Step 1 of a rotation (CRYPTO-1), atomic: the new key becomes current,
  // wrapped by the (possibly new) password and a NEW recovery key; previous
  // keys are kept wrapped under it until step 2 finishes. Other sessions are
  // signed out because they hold the old key.
  router.post('/rotation/start', limiters.sensitive, json, async (req, res) => {
    const body = parseBody(startRotationSchema, req.body);
    const wrappedVaultKey = parseWrappedKey(body.wrappedVaultKey, CONTEXTS.vaultKeyPassword, 'wrapped vault key');
    const wrappedVaultKeyRecovery = parseWrappedKey(
      body.wrappedVaultKeyRecovery,
      CONTEXTS.vaultKeyRecovery,
      'recovery-wrapped vault key'
    );
    for (const envelope of [wrappedVaultKey, wrappedVaultKeyRecovery]) {
      if (envelope.version !== 3 || envelope.keyId !== body.newKeyId) {
        throw badRequest('Rotated keys must be wrapped as v3 envelopes naming the new key', 'INVALID_ENVELOPE');
      }
    }

    const updated = await withTransaction(pool, async (db) => {
      await lockUserNotes(db, req.user.id);
      const user = await findUserById(db, req.user.id, { forUpdate: true });
      if (!user) {
        throw notFound('User not found', 'USER_NOT_FOUND');
      }
      await requireCurrentCredentials(ctx, user, { currentAuthSecret: body.currentAuthSecret });
      if (!user.vault_key_id) {
        throw conflict('Register the current vault key id first', 'KEY_ID_REQUIRED');
      }
      if (user.vault_key_id === body.newKeyId) {
        throw conflict('That key is already current', 'KEY_MISMATCH');
      }

      const keyring = { ...(user.vault_keyring || {}) };
      for (const [keyId, envelope] of Object.entries(body.keyring)) {
        const parsed = parseEnvelope(envelope, {
          context: CONTEXTS.keyring(keyId),
          label: 'keyring entry',
          exactBytes: WRAPPED_KEY_BYTES,
        });
        if (parsed.version !== 3 || parsed.keyId !== body.newKeyId) {
          throw badRequest('Keyring entries must be wrapped under the new key', 'INVALID_ENVELOPE');
        }
        keyring[keyId] = parsed;
      }
      // Re-wrap every key the account still needs under the new one.
      for (const keyId of Object.keys(keyring)) {
        if (!body.keyring[keyId]) {
          throw badRequest(`Previous key ${keyId} must be re-wrapped under the new key`, 'INVALID_ENVELOPE');
        }
      }
      if (!body.keyring[user.vault_key_id]) {
        throw badRequest('The current key must be added to the keyring', 'INVALID_ENVELOPE');
      }

      const result = await db.query(
        `
          UPDATE users SET
            auth_salt = $2, kdf_params = $3, auth_verifier_hash = $4, wrapped_vault_key = $5,
            recovery_verifier_hash = $6, wrapped_vault_key_recovery = $7,
            vault_key_id = $8, vault_keyring = $9, rotation_started_at = NOW(),
            recovery_key_updated_at = NOW(), updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          user.id,
          body.authSalt,
          JSON.stringify(body.kdfParams),
          ctx.verifier.hash(body.authVerifier),
          JSON.stringify(wrappedVaultKey),
          ctx.verifier.hash(body.recoveryVerifier),
          JSON.stringify(wrappedVaultKeyRecovery),
          body.newKeyId,
          JSON.stringify(keyring),
        ]
      );
      await sessions.revokeAllForUser(user.id, { exceptSessionId: req.session.id, db });
      return result.rows[0];
    });

    res.json(buildE2EEAuthResponse(updated, { expiresAt: req.session.expiresAt }));
  });

  // Final step of a rotation or format upgrade: only when nothing still
  // needs an old key or an unauthenticated (v1/v2) envelope. Previous keys
  // are then discarded and v1/v2 data is refused from now on (CRYPTO-5).
  router.post('/rotation/complete', limiters.sensitive, async (req, res) => {
    const updated = await withTransaction(pool, async (db) => {
      await lockUserNotes(db, req.user.id);
      const user = await findUserById(db, req.user.id, { forUpdate: true });
      if (!user.vault_key_id) {
        throw conflict('Register the vault key id first', 'KEY_ID_REQUIRED');
      }
      const pending = await pendingSummary(db, user);
      if (!isComplete(pending)) {
        throw conflict('Some data still needs to be re-encrypted', 'ROTATION_INCOMPLETE', { pending });
      }
      const result = await db.query(
        `
          UPDATE users SET vault_keyring = '{}'::jsonb, rotation_started_at = NULL,
            min_envelope_version = 3, updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [user.id]
      );
      return result.rows[0];
    });
    res.json(buildE2EEAuthResponse(updated, { expiresAt: req.session.expiresAt }));
  });

  return router;
}
