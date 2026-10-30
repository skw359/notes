import bcrypt from 'bcryptjs';
import { unauthorized } from '../lib/errors.js';
import { kdfParamsSchema } from '../lib/validation.js';

// Emails are stored lower-case since 2.0; older mixed-case rows still match.
export async function findUserByEmail(db, email) {
  const result = await db.query(
    'SELECT * FROM users WHERE lower(email) = lower($1) ORDER BY (email = $1) DESC, id ASC LIMIT 1',
    [email]
  );
  return result.rows[0] || null;
}

export async function findUserById(db, id, { forUpdate = false } = {}) {
  const result = await db.query(`SELECT * FROM users WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return result.rows[0] || null;
}

// Envelopes written now must use the account's current key (when known).
export async function currentVaultKeyId(db, userId) {
  const result = await db.query('SELECT vault_key_id FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.vault_key_id || undefined;
}

// JSONB reorders object keys, which made real prelogin responses
// distinguishable from decoys (SEC-9). Both are built in this key order.
export function canonicalKdfParams(params) {
  const parsed = kdfParamsSchema.safeParse(params);
  return parsed.success ? parsed.data : params;
}

export function buildVaultBootstrap(user) {
  return {
    salt: user.auth_salt,
    kdfParams: canonicalKdfParams(user.kdf_params),
    wrappedVaultKey: user.wrapped_vault_key,
    vaultVersion: user.vault_version || 1,
    vaultKeyId: user.vault_key_id || null,
    keyring: user.vault_keyring || {},
    rotationStartedAt: user.rotation_started_at || null,
    minEnvelopeVersion: user.min_envelope_version || 1,
    recoveryKeyUpdatedAt: user.recovery_key_updated_at || null,
  };
}

function sessionInfo(session) {
  return session ? { expiresAt: session.expiresAt ?? session.expires_at ?? null } : undefined;
}

export function buildE2EEAuthResponse(user, session) {
  return {
    user: {
      id: user.id,
      email: user.email,
      auth_mode: 'e2ee',
      created_at: user.created_at,
    },
    vaultBootstrap: buildVaultBootstrap(user),
    encryptedProfile: user.encrypted_profile,
    profileBlobId: user.profile_blob_id ?? null,
    profileRefKnown: Boolean(user.profile_ref_known),
    session: sessionInfo(session),
  };
}

export function buildLegacyAuthResponse(user, session) {
  return {
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      profile_picture: user.profile_picture,
      created_at: user.created_at,
      auth_mode: 'legacy',
    },
    migrationRequired: true,
    session: sessionInfo(session),
  };
}

export function buildAuthResponse(user, session) {
  return user.auth_mode === 'e2ee' ? buildE2EEAuthResponse(user, session) : buildLegacyAuthResponse(user, session);
}

// Verifies the HKDF auth secret and transparently replaces a pre-2.0 Argon2
// hash with the HMAC form on success.
export async function verifyAuthSecret({ pool, verifier }, user, authSecret) {
  const { valid, needsUpgrade } = await verifier.verify(user.auth_verifier_hash, authSecret);
  if (valid && needsUpgrade) {
    await pool.query('UPDATE users SET auth_verifier_hash = $2 WHERE id = $1', [user.id, verifier.hash(authSecret)]);
  }
  return valid;
}

export async function verifyRecoveryVerifier({ pool, verifier }, user, recoveryVerifier) {
  const { valid, needsUpgrade } = await verifier.verify(user.recovery_verifier_hash, recoveryVerifier);
  if (valid && needsUpgrade) {
    await pool.query('UPDATE users SET recovery_verifier_hash = $2 WHERE id = $1', [
      user.id,
      verifier.hash(recoveryVerifier),
    ]);
  }
  return valid;
}

export async function verifyLegacyPassword(user, password) {
  if (!user.password_hash || typeof password !== 'string' || !password) {
    return false;
  }
  try {
    return await bcrypt.compare(password, user.password_hash);
  } catch {
    return false;
  }
}

// Re-authentication for destructive or key-changing operations (SEC-6).
export async function requireCurrentCredentials(ctx, user, { currentAuthSecret, password }) {
  const valid =
    user.auth_mode === 'e2ee'
      ? await verifyAuthSecret(ctx, user, currentAuthSecret)
      : await verifyLegacyPassword(user, password);
  if (!valid) {
    throw unauthorized(
      user.auth_mode === 'e2ee' ? 'Your current password is incorrect' : 'Your password is incorrect',
      'INVALID_CREDENTIALS'
    );
  }
}
