import crypto from 'crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { lockUserNotes, withTransaction } from '../db.js';
import { timingSafeEqualStrings } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { extractLegacyFilenamesFromContent, quarantineLegacyFile } from '../lib/legacyUploads.js';
import { clearSessionCookie, setSessionCookie } from '../lib/sessions.js';
import {
  CONTEXTS,
  emailSchema,
  idListSchema,
  idSchema,
  keyIdSchema,
  kdfParamsSchema,
  parseBody,
  parseEnvelope,
  parseProfileEnvelope,
  parseWrappedKey,
  saltSchema,
  verifierSchema,
} from '../lib/validation.js';
import {
  buildAuthResponse,
  buildE2EEAuthResponse,
  canonicalKdfParams,
  findUserByEmail,
  findUserById,
  requireCurrentCredentials,
  verifyAuthSecret,
  verifyLegacyPassword,
  verifyRecoveryVerifier,
} from '../services/accounts.js';

const DECOY_KDF_PARAMS = canonicalKdfParams({
  algorithm: 'argon2id',
  time: 3,
  mem: 65536,
  hashLen: 32,
  parallelism: 1,
});

const MIGRATION_STAGE_BATCH = 200;

const preloginSchema = z.object({ email: emailSchema });

const signupSchema = z.strictObject({
  email: emailSchema,
  inviteCode: z.string().max(256).optional(),
  authSalt: saltSchema,
  kdfParams: kdfParamsSchema,
  authVerifier: verifierSchema,
  recoveryVerifier: verifierSchema,
  wrappedVaultKey: z.unknown(),
  wrappedVaultKeyRecovery: z.unknown(),
  encryptedProfile: z.unknown(),
  vaultKeyId: keyIdSchema.optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  authSecret: verifierSchema.optional(),
  password: z.string().min(1).max(1024).optional(),
});

const recoverBeginSchema = z.object({ email: emailSchema, recoveryVerifier: verifierSchema });

const recoverSchema = z.strictObject({
  email: emailSchema,
  recoveryVerifier: verifierSchema,
  authSalt: saltSchema,
  kdfParams: kdfParamsSchema,
  authVerifier: verifierSchema,
  wrappedVaultKey: z.unknown(),
  nextRecoveryVerifier: verifierSchema.optional(),
  wrappedVaultKeyRecovery: z.unknown().optional(),
});

const rekeySchema = z.strictObject({
  currentAuthSecret: verifierSchema,
  authSalt: saltSchema,
  kdfParams: kdfParamsSchema,
  authVerifier: verifierSchema,
  wrappedVaultKey: z.unknown(),
  // Sent only by pre-2.0 clients, which always rotated the recovery key too.
  nextRecoveryVerifier: verifierSchema.optional(),
  wrappedVaultKeyRecovery: z.unknown().optional(),
});

const recoveryKeySchema = z.strictObject({
  currentAuthSecret: verifierSchema,
  recoveryVerifier: verifierSchema,
  wrappedVaultKeyRecovery: z.unknown(),
});

const stageSchema = z.strictObject({
  notes: z
    .array(
      z.strictObject({
        id: idSchema,
        sourceRevision: z.number().int().min(0),
        encryptedContent: z.unknown(),
        encryptedSummary: z.unknown(),
        blobIds: idListSchema.default([]),
      })
    )
    .min(1)
    .max(MIGRATION_STAGE_BATCH),
});

const migrateSchema = z.strictObject({
  authSalt: saltSchema,
  kdfParams: kdfParamsSchema,
  authVerifier: verifierSchema,
  recoveryVerifier: verifierSchema,
  wrappedVaultKey: z.unknown(),
  wrappedVaultKeyRecovery: z.unknown(),
  encryptedProfile: z.unknown(),
  vaultKeyId: keyIdSchema.optional(),
  profileBlobId: idSchema.nullable().optional(),
  migratedFiles: z
    .array(z.strictObject({ filename: z.string().min(1).max(255), blobId: idSchema }))
    .max(100000)
    .default([]),
});

// Deterministic per-email decoy so probing an unknown email returns a stable,
// real-looking prelogin response instead of revealing whether it exists.
function decoySalt(secret, email) {
  return crypto
    .createHmac('sha256', `${secret}:prelogin-decoy`)
    .update(email)
    .digest()
    .subarray(0, 16)
    .toString('base64');
}

function preloginResponse(salt, kdfParams) {
  return { authMode: 'e2ee', salt, kdfParams };
}

// The password-wrapped key and recovery-wrapped key must agree with the key
// the account already uses (when it is known).
function assertKeyId(envelope, expectedKeyId, label) {
  if (expectedKeyId && envelope.version === 3 && envelope.keyId !== expectedKeyId) {
    throw badRequest(`The ${label} was wrapped for a different vault key`, 'KEY_MISMATCH');
  }
}

export function createAuthRouter(ctx) {
  const { pool, config, sessions, verifier, limiters, requireSession, optionalSession } = ctx;
  const router = Router();
  const json = express.json({ limit: config.limits.authBodyBytes });
  const jsonLarge = express.json({ limit: config.limits.notesBodyBytes });

  async function startSession(res, req, user, origin, db = pool) {
    const session = await sessions.create(user.id, req, { origin, db });
    setSessionCookie(res, req, config, session.token, session.expiresAt);
    return session;
  }

  router.post('/prelogin', limiters.prelogin, json, async (req, res) => {
    const { email } = parseBody(preloginSchema, req.body);
    const user = await findUserByEmail(pool, email);

    if (user?.auth_mode === 'legacy') {
      // Pre-encryption accounts must send the password for a one-time
      // upgrade; they cannot be hidden behind the decoy.
      return res.json({ authMode: 'legacy' });
    }

    // Unknown accounts and broken e2ee rows (no salt) get the same decoy, so
    // the response shape never reveals whether an email is registered.
    const kdfParams = user ? canonicalKdfParams(user.kdf_params) : null;
    if (!user || !user.auth_salt || !kdfParamsSchema.safeParse(kdfParams).success) {
      return res.json(preloginResponse(decoySalt(config.jwtSecret, email), DECOY_KDF_PARAMS));
    }
    return res.json(preloginResponse(user.auth_salt, kdfParams));
  });

  router.post('/signup', limiters.signup, json, async (req, res) => {
    if (config.signup.mode === 'closed') {
      throw forbidden('Registration is closed on this server', 'SIGNUP_DISABLED');
    }
    const body = parseBody(signupSchema, req.body);
    if (config.signup.mode === 'invite' && !timingSafeEqualStrings(body.inviteCode, config.signup.inviteCode)) {
      throw forbidden('A valid invite code is required to register', 'INVITE_REQUIRED');
    }

    const wrappedVaultKey = parseWrappedKey(body.wrappedVaultKey, CONTEXTS.vaultKeyPassword, 'wrapped vault key');
    const wrappedVaultKeyRecovery = parseWrappedKey(
      body.wrappedVaultKeyRecovery,
      CONTEXTS.vaultKeyRecovery,
      'recovery-wrapped vault key'
    );
    const encryptedProfile = parseProfileEnvelope(body.encryptedProfile);
    assertKeyId(wrappedVaultKey, body.vaultKeyId, 'wrapped vault key');
    assertKeyId(wrappedVaultKeyRecovery, body.vaultKeyId, 'recovery-wrapped vault key');

    if (await findUserByEmail(pool, body.email)) {
      throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
    }

    const result = await withTransaction(pool, async (db) => {
      let inserted;
      try {
        inserted = await db.query(
          `
            INSERT INTO users (
              email, auth_mode, auth_salt, kdf_params, auth_verifier_hash, recovery_verifier_hash,
              wrapped_vault_key, wrapped_vault_key_recovery, encrypted_profile, vault_version,
              vault_key_id, profile_ref_known, recovery_key_updated_at
            )
            VALUES ($1, 'e2ee', $2, $3, $4, $5, $6, $7, $8, 1, $9, TRUE, NOW())
            RETURNING *
          `,
          [
            body.email,
            body.authSalt,
            JSON.stringify(body.kdfParams),
            verifier.hash(body.authVerifier),
            verifier.hash(body.recoveryVerifier),
            JSON.stringify(wrappedVaultKey),
            JSON.stringify(wrappedVaultKeyRecovery),
            JSON.stringify(encryptedProfile),
            body.vaultKeyId ?? null,
          ]
        );
      } catch (error) {
        // Two concurrent signups for one email: the loser gets a 409, not a 500.
        if (error.code === '23505') {
          throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
        }
        throw error;
      }
      const user = inserted.rows[0];
      const session = await startSession(res, req, user, 'signup', db);
      return { user, session };
    });

    res.status(201).json(buildE2EEAuthResponse(result.user, result.session));
  });

  router.post('/login', limiters.loginIp, json, limiters.loginAccount, async (req, res) => {
    const { email, authSecret, password } = parseBody(loginSchema, req.body);
    if (!authSecret && !password) {
      throw badRequest('Email and credentials are required');
    }

    const user = await findUserByEmail(pool, email);
    if (!user) {
      verifier.burn(authSecret || password);
      throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    }

    const valid =
      user.auth_mode === 'e2ee'
        ? await verifyAuthSecret(ctx, user, authSecret)
        : await verifyLegacyPassword(user, password);
    if (!valid) {
      throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    }

    const session = await startSession(res, req, user, 'login');
    res.json(buildAuthResponse(user, session));
  });

  // Revokes this session server-side; the cookie alone no longer works after
  // logout (SEC-4).
  router.post('/logout', optionalSession, async (req, res) => {
    if (req.session?.id) {
      await sessions.revoke(req.session.id);
    }
    clearSessionCookie(res, req, config);
    res.json({ message: 'Logged out' });
  });

  router.post('/recover/begin', limiters.recoverIp, json, limiters.recoverAccount, async (req, res) => {
    const { email, recoveryVerifier } = parseBody(recoverBeginSchema, req.body);
    const user = await findUserByEmail(pool, email);
    if (!user || user.auth_mode !== 'e2ee' || !user.recovery_verifier_hash) {
      verifier.burn(recoveryVerifier);
      throw unauthorized('Invalid recovery key', 'INVALID_RECOVERY_KEY');
    }
    if (!(await verifyRecoveryVerifier(ctx, user, recoveryVerifier))) {
      throw unauthorized('Invalid recovery key', 'INVALID_RECOVERY_KEY');
    }
    res.json({
      wrappedVaultKeyRecovery: user.wrapped_vault_key_recovery,
      vaultKeyId: user.vault_key_id || null,
    });
  });

  // Password reset with the recovery key. Signs out every existing session,
  // so a recovery also evicts whoever may have had access (SEC-4).
  router.post('/recover', limiters.recoverIp, json, limiters.recoverAccount, async (req, res) => {
    const body = parseBody(recoverSchema, req.body);
    const user = await findUserByEmail(pool, body.email);
    if (!user || user.auth_mode !== 'e2ee' || !user.recovery_verifier_hash) {
      verifier.burn(body.recoveryVerifier);
      throw unauthorized('Invalid recovery key', 'INVALID_RECOVERY_KEY');
    }
    if (!(await verifyRecoveryVerifier(ctx, user, body.recoveryVerifier))) {
      throw unauthorized('Invalid recovery key', 'INVALID_RECOVERY_KEY');
    }

    const wrappedVaultKey = parseWrappedKey(body.wrappedVaultKey, CONTEXTS.vaultKeyPassword, 'wrapped vault key');
    assertKeyId(wrappedVaultKey, user.vault_key_id, 'wrapped vault key');

    let wrappedVaultKeyRecovery = null;
    if (body.nextRecoveryVerifier || body.wrappedVaultKeyRecovery) {
      if (!body.nextRecoveryVerifier || !body.wrappedVaultKeyRecovery) {
        throw badRequest('A new recovery key needs both its verifier and wrapped key');
      }
      wrappedVaultKeyRecovery = parseWrappedKey(
        body.wrappedVaultKeyRecovery,
        CONTEXTS.vaultKeyRecovery,
        'recovery-wrapped vault key'
      );
      assertKeyId(wrappedVaultKeyRecovery, user.vault_key_id, 'recovery-wrapped vault key');
    }

    const result = await withTransaction(pool, async (db) => {
      const updated = await db.query(
        `
          UPDATE users SET
            auth_salt = $2, kdf_params = $3, auth_verifier_hash = $4, wrapped_vault_key = $5,
            recovery_verifier_hash = COALESCE($6, recovery_verifier_hash),
            wrapped_vault_key_recovery = COALESCE($7::jsonb, wrapped_vault_key_recovery),
            recovery_key_updated_at = CASE WHEN $6::text IS NULL THEN recovery_key_updated_at ELSE NOW() END,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          user.id,
          body.authSalt,
          JSON.stringify(body.kdfParams),
          verifier.hash(body.authVerifier),
          JSON.stringify(wrappedVaultKey),
          body.nextRecoveryVerifier ? verifier.hash(body.nextRecoveryVerifier) : null,
          wrappedVaultKeyRecovery ? JSON.stringify(wrappedVaultKeyRecovery) : null,
        ]
      );
      await sessions.revokeAllForUser(user.id, { db });
      const session = await startSession(res, req, updated.rows[0], 'recover', db);
      return { user: updated.rows[0], session };
    });

    res.json(buildE2EEAuthResponse(result.user, result.session));
  });

  // Password change. Re-wraps the vault key under the new password only: the
  // recovery key stays valid (it used to be replaced silently, CRYPTO-4).
  // Other sessions are signed out.
  router.post('/rekey', requireSession, limiters.sensitive, json, async (req, res) => {
    const body = parseBody(rekeySchema, req.body);
    const user = await findUserById(pool, req.user.id);
    if (!user || user.auth_mode !== 'e2ee') {
      throw notFound('User not found', 'USER_NOT_FOUND');
    }
    await requireCurrentCredentials(ctx, user, { currentAuthSecret: body.currentAuthSecret });

    const wrappedVaultKey = parseWrappedKey(body.wrappedVaultKey, CONTEXTS.vaultKeyPassword, 'wrapped vault key');
    assertKeyId(wrappedVaultKey, user.vault_key_id, 'wrapped vault key');
    let wrappedVaultKeyRecovery = null;
    if (body.nextRecoveryVerifier && body.wrappedVaultKeyRecovery) {
      wrappedVaultKeyRecovery = parseWrappedKey(
        body.wrappedVaultKeyRecovery,
        CONTEXTS.vaultKeyRecovery,
        'recovery-wrapped vault key'
      );
    }

    const updated = await withTransaction(pool, async (db) => {
      const result = await db.query(
        `
          UPDATE users SET
            auth_salt = $2, kdf_params = $3, auth_verifier_hash = $4, wrapped_vault_key = $5,
            recovery_verifier_hash = COALESCE($6, recovery_verifier_hash),
            wrapped_vault_key_recovery = COALESCE($7::jsonb, wrapped_vault_key_recovery),
            recovery_key_updated_at = CASE WHEN $6::text IS NULL THEN recovery_key_updated_at ELSE NOW() END,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          user.id,
          body.authSalt,
          JSON.stringify(body.kdfParams),
          verifier.hash(body.authVerifier),
          JSON.stringify(wrappedVaultKey),
          wrappedVaultKeyRecovery ? verifier.hash(body.nextRecoveryVerifier) : null,
          wrappedVaultKeyRecovery ? JSON.stringify(wrappedVaultKeyRecovery) : null,
        ]
      );
      await sessions.revokeAllForUser(user.id, { exceptSessionId: req.session.id, db });
      return result.rows[0];
    });

    res.json(buildE2EEAuthResponse(updated, { expiresAt: req.session.expiresAt }));
  });

  // CRYPTO-2 / CRYPTO-4: replace the recovery key deliberately (password
  // required). The client shows the new key and has it acknowledged before
  // calling this, so a lost response can never leave the user without one.
  router.post('/recovery-key', requireSession, limiters.sensitive, json, async (req, res) => {
    const body = parseBody(recoveryKeySchema, req.body);
    const user = await findUserById(pool, req.user.id);
    if (!user || user.auth_mode !== 'e2ee') {
      throw notFound('User not found', 'USER_NOT_FOUND');
    }
    await requireCurrentCredentials(ctx, user, { currentAuthSecret: body.currentAuthSecret });
    const wrapped = parseWrappedKey(body.wrappedVaultKeyRecovery, CONTEXTS.vaultKeyRecovery, 'recovery-wrapped vault key');
    assertKeyId(wrapped, user.vault_key_id, 'recovery-wrapped vault key');

    const result = await pool.query(
      `
        UPDATE users SET recovery_verifier_hash = $2, wrapped_vault_key_recovery = $3,
          recovery_key_updated_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING recovery_key_updated_at
      `,
      [user.id, verifier.hash(body.recoveryVerifier), JSON.stringify(wrapped)]
    );
    res.json({ recoveryKeyUpdatedAt: result.rows[0].recovery_key_updated_at });
  });

  router.get('/me', requireSession, async (req, res) => {
    const user = await findUserById(pool, req.user.id);
    if (!user) {
      throw notFound('User not found', 'USER_NOT_FOUND');
    }
    res.json(buildAuthResponse(user, { expiresAt: req.session.expiresAt }));
  });

  router.get('/sessions', requireSession, async (req, res) => {
    const list = await sessions.list(req.user.id);
    res.json({
      sessions: list.map((session) => ({
        id: session.id,
        current: session.id === req.session.id,
        createdAt: session.created_at,
        lastSeenAt: session.last_seen_at,
        expiresAt: session.expires_at,
        origin: session.origin,
        userAgent: session.user_agent,
        ip: session.ip,
      })),
    });
  });

  router.delete('/sessions/:sessionId', requireSession, async (req, res) => {
    const sessionId = z.string().regex(/^[0-9a-f]{64}$/).parse(req.params.sessionId);
    const revoked = await sessions.revoke(sessionId, { userId: req.user.id });
    if (!revoked) {
      throw notFound('Session not found', 'SESSION_NOT_FOUND');
    }
    if (sessionId === req.session.id) {
      clearSessionCookie(res, req, config);
    }
    res.json({ revoked: true });
  });

  router.post('/sessions/revoke-others', requireSession, limiters.sensitive, async (req, res) => {
    const revoked = await sessions.revokeAllForUser(req.user.id, { exceptSessionId: req.session.id });
    res.json({ revoked });
  });

  // ── Legacy (pre-encryption) account migration ──────────────────────────
  // DATA-5: the server is the source of truth for what must be migrated:
  // every note including trashed ones, the profile and the owned files.
  router.get('/migration-set', requireSession, async (req, res) => {
    if (req.user.authMode !== 'legacy') {
      throw conflict('This account is already encrypted', 'ALREADY_MIGRATED');
    }
    const [user, notes, files, staged] = await Promise.all([
      findUserById(pool, req.user.id),
      pool.query(
        `
          SELECT id, content, revision, created_at, updated_at, deleted_at
          FROM notes WHERE user_id = $1 ORDER BY id ASC
        `,
        [req.user.id]
      ),
      pool.query(
        `
          SELECT filename, byte_length FROM legacy_uploads
          WHERE user_id = $1 AND quarantined_at IS NULL ORDER BY filename
        `,
        [req.user.id]
      ),
      pool.query('SELECT note_id, source_revision FROM migration_staging WHERE user_id = $1', [req.user.id]),
    ]);

    const owned = new Set(files.rows.map((row) => row.filename));
    const referenced = new Set();
    for (const note of notes.rows) {
      for (const filename of extractLegacyFilenamesFromContent(note.content)) {
        referenced.add(filename);
      }
    }

    res.json({
      notes: notes.rows,
      profile: {
        first_name: user.first_name || '',
        last_name: user.last_name || '',
        profile_picture: user.profile_picture || null,
      },
      files: files.rows.map((row) => ({ filename: row.filename, byteLength: row.byte_length })),
      // Referenced by notes but not provably owned (or gone): the client
      // replaces these with a "missing file" placeholder instead of failing.
      unavailableFiles: [...referenced].filter((filename) => !owned.has(filename)),
      staged: staged.rows.map((row) => ({ noteId: row.note_id, sourceRevision: row.source_revision })),
    });
  });

  router.post('/migration/stage', requireSession, jsonLarge, async (req, res) => {
    if (req.user.authMode !== 'legacy') {
      throw conflict('This account is already encrypted', 'ALREADY_MIGRATED');
    }
    const { notes } = parseBody(stageSchema, req.body);
    const prepared = notes.map((note) => ({
      ...note,
      encryptedContent: parseEnvelope(note.encryptedContent, {
        context: CONTEXTS.noteContent(note.id),
        label: 'note content',
        maxBytes: config.limits.noteMaxBytes,
      }),
      encryptedSummary: parseEnvelope(note.encryptedSummary, {
        context: CONTEXTS.noteSummary(note.id),
        label: 'note summary',
        maxBytes: 64 * 1024,
      }),
    }));

    await withTransaction(pool, async (db) => {
      const ids = prepared.map((note) => note.id);
      const owned = await db.query('SELECT id FROM notes WHERE user_id = $1 AND id = ANY($2::int[])', [
        req.user.id,
        ids,
      ]);
      if (owned.rows.length !== new Set(ids).size) {
        throw notFound('One or more notes do not exist', 'NOTE_NOT_FOUND');
      }
      const allBlobIds = [...new Set(prepared.flatMap((note) => note.blobIds))];
      const ownedBlobs = allBlobIds.length
        ? new Set(
            (
              await db.query('SELECT id FROM blobs WHERE user_id = $1 AND id = ANY($2::int[])', [
                req.user.id,
                allBlobIds,
              ])
            ).rows.map((row) => row.id)
          )
        : new Set();

      for (const note of prepared) {
        await db.query(
          `
            INSERT INTO migration_staging
              (note_id, user_id, source_revision, encrypted_content, encrypted_summary, blob_ids)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (note_id) DO UPDATE SET
              source_revision = EXCLUDED.source_revision,
              encrypted_content = EXCLUDED.encrypted_content,
              encrypted_summary = EXCLUDED.encrypted_summary,
              blob_ids = EXCLUDED.blob_ids,
              staged_at = NOW()
          `,
          [
            note.id,
            req.user.id,
            note.sourceRevision,
            JSON.stringify(note.encryptedContent),
            JSON.stringify(note.encryptedSummary),
            note.blobIds.filter((id) => ownedBlobs.has(id)),
          ]
        );
      }
    });

    res.json({ staged: prepared.length });
  });

  // The atomic switch. Every note (trashed ones included) must have been
  // staged from its current revision; a note edited since staging fails the
  // whole switch with MIGRATION_STALE, so no edit is overwritten. Writes from
  // other legacy tabs are serialized behind the same locks (DATA-7).
  router.post('/migrate', requireSession, limiters.sensitive, jsonLarge, async (req, res) => {
    const body = parseBody(migrateSchema, req.body);
    const wrappedVaultKey = parseWrappedKey(body.wrappedVaultKey, CONTEXTS.vaultKeyPassword, 'wrapped vault key');
    const wrappedVaultKeyRecovery = parseWrappedKey(
      body.wrappedVaultKeyRecovery,
      CONTEXTS.vaultKeyRecovery,
      'recovery-wrapped vault key'
    );
    const encryptedProfile = parseProfileEnvelope(body.encryptedProfile);
    assertKeyId(wrappedVaultKey, body.vaultKeyId, 'wrapped vault key');
    assertKeyId(wrappedVaultKeyRecovery, body.vaultKeyId, 'recovery-wrapped vault key');

    const migrated = await withTransaction(pool, async (db) => {
      await lockUserNotes(db, req.user.id);
      const user = await findUserById(db, req.user.id, { forUpdate: true });
      if (!user) {
        throw notFound('User not found', 'USER_NOT_FOUND');
      }
      if (user.auth_mode !== 'legacy') {
        throw conflict('This account is already encrypted', 'ALREADY_MIGRATED');
      }

      const notes = await db.query('SELECT id, revision FROM notes WHERE user_id = $1 FOR UPDATE', [user.id]);
      const staged = await db.query(
        'SELECT note_id, source_revision FROM migration_staging WHERE user_id = $1',
        [user.id]
      );
      const stagedRevision = new Map(staged.rows.map((row) => [row.note_id, row.source_revision]));
      const missing = notes.rows.filter((note) => !stagedRevision.has(note.id)).map((note) => note.id);
      const stale = notes.rows
        .filter((note) => stagedRevision.has(note.id) && stagedRevision.get(note.id) !== note.revision)
        .map((note) => note.id);
      if (missing.length || stale.length) {
        throw conflict('Notes changed while the upgrade was being prepared. Retrying will pick them up.', 'MIGRATION_STALE', {
          missing,
          stale,
        });
      }

      let profileBlobId = null;
      if (body.profileBlobId) {
        const owned = await db.query('SELECT id FROM blobs WHERE id = $1 AND user_id = $2', [
          body.profileBlobId,
          user.id,
        ]);
        profileBlobId = owned.rows[0]?.id ?? null;
      }

      const updatedUser = await db.query(
        `
          UPDATE users SET
            auth_mode = 'e2ee', password_hash = NULL, first_name = NULL, last_name = NULL,
            profile_picture = NULL, auth_salt = $2, kdf_params = $3, auth_verifier_hash = $4,
            recovery_verifier_hash = $5, wrapped_vault_key = $6, wrapped_vault_key_recovery = $7,
            encrypted_profile = $8, vault_version = 1, vault_key_id = $9,
            profile_blob_id = $10, profile_ref_known = TRUE, recovery_key_updated_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          user.id,
          body.authSalt,
          JSON.stringify(body.kdfParams),
          verifier.hash(body.authVerifier),
          verifier.hash(body.recoveryVerifier),
          JSON.stringify(wrappedVaultKey),
          JSON.stringify(wrappedVaultKeyRecovery),
          JSON.stringify(encryptedProfile),
          body.vaultKeyId ?? null,
          profileBlobId,
        ]
      );

      // Trashed notes stay trashed: deleted_at is not touched.
      await db.query(
        `
          UPDATE notes n SET
            content = NULL,
            encrypted_content = s.encrypted_content,
            encrypted_summary = s.encrypted_summary,
            revision = n.revision + 1,
            blob_refs_known = TRUE
          FROM migration_staging s
          WHERE s.note_id = n.id AND n.user_id = $1
        `,
        [user.id]
      );
      await db.query(
        `
          INSERT INTO blob_refs (note_id, blob_id)
          SELECT s.note_id, unnest(s.blob_ids) FROM migration_staging s WHERE s.user_id = $1
          ON CONFLICT DO NOTHING
        `,
        [user.id]
      );
      await db.query('DELETE FROM migration_staging WHERE user_id = $1', [user.id]);

      for (const file of body.migratedFiles) {
        await db.query(
          `
            UPDATE legacy_uploads SET migrated_blob_id = b.id, migrated_at = NOW()
            FROM blobs b
            WHERE legacy_uploads.filename = $1 AND legacy_uploads.user_id = $2
              AND b.id = $3 AND b.user_id = $2
          `,
          [file.filename, user.id, file.blobId]
        );
      }

      // Other devices still in legacy mode must re-authenticate.
      await sessions.revokeAllForUser(user.id, { exceptSessionId: req.session.id, db });
      return updatedUser.rows[0];
    });

    // Post-commit cleanup is best effort and never turns a committed
    // migration into an error response (CRYPTO-2): plaintext files move to
    // quarantine and are deleted after the retention period (CRYPTO-3).
    let quarantined = 0;
    try {
      const owned = await pool.query(
        'SELECT filename FROM legacy_uploads WHERE user_id = $1 AND quarantined_at IS NULL',
        [migrated.id]
      );
      for (const { filename } of owned.rows) {
        if (await quarantineLegacyFile(config.storage, filename)) {
          quarantined += 1;
        }
        await pool.query('UPDATE legacy_uploads SET quarantined_at = NOW() WHERE filename = $1', [filename]);
      }
    } catch (error) {
      console.error('[migrate] post-commit cleanup failed (migration itself succeeded):', error);
    }

    res.json({
      ...buildE2EEAuthResponse(migrated, { expiresAt: req.session.expiresAt }),
      quarantinedFiles: quarantined,
    });
  });

  return router;
}
