import { Router } from 'express';
import { z } from 'zod';
import { lockUserNotes, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { quarantineLegacyFile } from '../lib/legacyUploads.js';
import { clearSessionCookie } from '../lib/sessions.js';
import { idSchema, parseBody, parseProfileEnvelope, verifierSchema } from '../lib/validation.js';
import { currentVaultKeyId, findUserById, requireCurrentCredentials } from '../services/accounts.js';

const e2eeProfileSchema = z.strictObject({
  encryptedProfile: z.unknown(),
  // The blob holding the (encrypted) profile picture, so the collector keeps
  // it. Omitted by pre-2.0 clients, which leaves the reference unknown.
  profileBlobId: idSchema.nullable().optional(),
  // Pre-2.0 clients asked the server to delete the old picture immediately;
  // the collector handles that now.
  previousProfilePictureBlobId: z.union([idSchema, z.string()]).nullable().optional(),
});

const legacyProfileSchema = z.strictObject({
  first_name: z.string().trim().max(100).optional(),
  last_name: z.string().trim().max(100).optional(),
});

const deleteAccountSchema = z.strictObject({
  confirm: z.literal('DELETE'),
  currentAuthSecret: verifierSchema.optional(),
  password: z.string().min(1).max(1024).optional(),
});

export function createUsersRouter(ctx) {
  const { pool, config, storage, limiters, requireSession } = ctx;
  const router = Router();

  router.use(requireSession);

  router.put('/profile', limiters.api, async (req, res) => {
    if (req.is('multipart/form-data')) {
      throw badRequest('Profile picture uploads for unencrypted accounts were removed', 'UNSUPPORTED');
    }

    if (req.user.authMode === 'e2ee') {
      const body = parseBody(e2eeProfileSchema, req.body);
      const encryptedProfile = parseProfileEnvelope(body.encryptedProfile);
      const keyId = await currentVaultKeyId(pool, req.user.id);
      if (keyId && encryptedProfile.version === 3 && encryptedProfile.keyId !== keyId) {
        throw conflict('The encryption key changed on another device. Unlock again to continue.', 'KEY_ROTATED');
      }

      await withTransaction(pool, async (db) => {
        await lockUserNotes(db, req.user.id);
        let profileBlobId = null;
        if (body.profileBlobId) {
          const owned = await db.query('SELECT id FROM blobs WHERE id = $1 AND user_id = $2', [
            body.profileBlobId,
            req.user.id,
          ]);
          if (!owned.rows.length) {
            throw notFound('Profile picture not found', 'BLOB_NOT_FOUND');
          }
          profileBlobId = owned.rows[0].id;
          await db.query('UPDATE blobs SET unreferenced_since = NULL WHERE id = $1', [profileBlobId]);
        }

        const knowsReference = body.profileBlobId !== undefined;
        await db.query(
          `
            UPDATE users SET
              encrypted_profile = $2,
              profile_blob_id = CASE WHEN $3 THEN $4 ELSE profile_blob_id END,
              profile_ref_known = $3,
              updated_at = NOW()
            WHERE id = $1
          `,
          [req.user.id, JSON.stringify(encryptedProfile), knowsReference, profileBlobId]
        );
      });

      res.json({ ok: true });
      return;
    }

    const body = parseBody(legacyProfileSchema, req.body);
    if (!body.first_name && !body.last_name) {
      throw badRequest('No fields to update');
    }
    const result = await pool.query(
      `
        UPDATE users SET
          first_name = COALESCE(NULLIF($2, ''), first_name),
          last_name = COALESCE(NULLIF($3, ''), last_name),
          updated_at = NOW()
        WHERE id = $1 AND auth_mode = 'legacy'
        RETURNING id, email, first_name, last_name, profile_picture, created_at
      `,
      [req.user.id, body.first_name ?? '', body.last_name ?? '']
    );
    res.json({ user: { ...result.rows[0], auth_mode: 'legacy' } });
  });

  // SEC-6: irreversible, so it needs the current password (not just the
  // cookie) and a typed confirmation. Rows are deleted in one transaction
  // first; files are moved afterwards (blobs to the deleted-files area,
  // legacy plaintext to quarantine) and failures there are only logged.
  router.delete('/account', limiters.sensitive, async (req, res) => {
    const body = parseBody(deleteAccountSchema, req.body);
    const user = await findUserById(pool, req.user.id);
    if (!user) {
      throw notFound('User not found', 'USER_NOT_FOUND');
    }
    await requireCurrentCredentials(ctx, user, {
      currentAuthSecret: body.currentAuthSecret,
      password: body.password,
    });

    const { blobKeys, legacyFiles } = await withTransaction(pool, async (db) => {
      await lockUserNotes(db, user.id);
      const blobs = await db.query('SELECT storage_key FROM blobs WHERE user_id = $1', [user.id]);
      const files = await db.query(
        'SELECT filename FROM legacy_uploads WHERE user_id = $1 AND quarantined_at IS NULL',
        [user.id]
      );
      await db.query('DELETE FROM users WHERE id = $1', [user.id]);
      return {
        blobKeys: blobs.rows.map((row) => row.storage_key).filter(Boolean),
        legacyFiles: files.rows.map((row) => row.filename),
      };
    });

    let fileErrors = 0;
    for (const key of blobKeys) {
      try {
        await storage.moveToDeleted(key);
      } catch (error) {
        fileErrors += 1;
        console.error(`[account-delete] could not move blob file ${key}:`, error.message);
      }
    }
    for (const filename of legacyFiles) {
      try {
        await quarantineLegacyFile(config.storage, filename);
      } catch (error) {
        fileErrors += 1;
        console.error(`[account-delete] could not quarantine ${filename}:`, error.message);
      }
    }
    if (fileErrors) {
      console.error(`[account-delete] user ${user.id}: ${fileErrors} file(s) left for verify-storage to clean up`);
    }

    clearSessionCookie(res, req, config);
    res.json({ message: 'Account deleted' });
  });

  return router;
}
