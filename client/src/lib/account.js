import {
  CONTEXTS,
  DEFAULT_KDF_PARAMS,
  EnvelopeError,
  MIN_PASSWORD_LENGTH,
  createPasswordWrapping,
  createRecoveryWrapping,
  deriveRecoveryVerifier,
  deriveRecoveryWrappingKey,
  derivePasswordMaterial,
  keyFingerprint,
  normalizeRecoveryKey,
  randomBytes,
  unwrapVaultKey,
} from './envelope.js'
import { argon2id as defaultArgon2id } from './kdf.js'
import { Vault } from './vault.js'

export function assertPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long`)
  }
}

export async function encryptProfile(vault, profile) {
  return vault.encryptJson(
    {
      first_name: profile.first_name || '',
      last_name: profile.last_name || '',
      profile_picture_blob_id: profile.profile_picture_blob_id || null,
      profile_picture_blob_uuid: profile.profile_picture_blob_uuid || null,
      profile_picture_blob_version: profile.profile_picture_blob_version || null,
      profile_picture_key_id: profile.profile_picture_key_id || null,
      profile_picture_mime_type: profile.profile_picture_mime_type || null,
    },
    CONTEXTS.profile
  )
}

export async function decryptProfile(vault, encryptedProfile) {
  if (!encryptedProfile) {
    return { first_name: '', last_name: '', profile_picture_blob_id: null }
  }
  return vault.decryptJson(encryptedProfile, CONTEXTS.profile)
}

async function openVaultFromBootstrap(rawKey, bootstrap) {
  return Vault.open(rawKey, {
    keyring: bootstrap.keyring || {},
    minEnvelopeVersion: bootstrap.minEnvelopeVersion || 1,
  })
}

// Accounts created before key ids existed learn theirs on first unlock.
async function ensureKeyId(api, vault, bootstrap) {
  if (bootstrap.vaultKeyId && bootstrap.vaultKeyId !== vault.currentKeyId) {
    vault.lock()
    throw new EnvelopeError('KEY_MISMATCH', 'The server returned a vault key that does not match this account')
  }
  if (!bootstrap.vaultKeyId) {
    await api.post('/api/vault/key-id', { keyId: vault.currentKeyId })
    bootstrap.vaultKeyId = vault.currentKeyId
  }
}

export async function signup({ api, email, password, firstName, lastName, inviteCode, argon2id = defaultArgon2id }) {
  assertPasswordStrength(password)
  const raw = randomBytes(32)
  const keyId = await keyFingerprint(raw)
  const passwordWrapping = await createPasswordWrapping(password, raw, keyId, { argon2id })
  const recovery = await createRecoveryWrapping(raw, keyId)
  const vault = await Vault.open(raw)
  const encryptedProfile = await encryptProfile(vault, { first_name: firstName, last_name: lastName })

  const data = await api.post('/api/auth/signup', {
    email,
    ...(inviteCode ? { inviteCode } : {}),
    ...passwordWrapping,
    recoveryVerifier: recovery.recoveryVerifier,
    wrappedVaultKeyRecovery: recovery.wrappedVaultKeyRecovery,
    encryptedProfile,
    vaultKeyId: keyId,
  })
  return { data, vault, recoveryKey: recovery.recoveryKey }
}

export async function prelogin(api, email) {
  return api.post('/api/auth/prelogin', { email })
}

export async function loginEncrypted({ api, email, password, preloginData, argon2id = defaultArgon2id }) {
  const { authSecret, kek } = await derivePasswordMaterial(password, preloginData.salt, preloginData.kdfParams, {
    argon2id,
  })
  const data = await api.post('/api/auth/login', { email, authSecret })
  let raw
  try {
    raw = await unwrapVaultKey(kek, data.vaultBootstrap.wrappedVaultKey, CONTEXTS.vaultKeyPassword)
  } catch {
    throw new Error('Unable to unlock the vault with this password')
  }
  const vault = await openVaultFromBootstrap(raw, data.vaultBootstrap)
  await ensureKeyId(api, vault, data.vaultBootstrap)
  return { data, vault }
}

// The session cookie is still valid but the vault key is not in memory
// (reload, auto-lock): derive the KEK locally and unwrap.
export async function unlockWithPassword({ api, bootstrap, password, argon2id = defaultArgon2id }) {
  const { kek } = await derivePasswordMaterial(password, bootstrap.salt, bootstrap.kdfParams, { argon2id })
  let raw
  try {
    raw = await unwrapVaultKey(kek, bootstrap.wrappedVaultKey, CONTEXTS.vaultKeyPassword)
  } catch {
    throw new Error('Invalid password')
  }
  const vault = await openVaultFromBootstrap(raw, bootstrap)
  await ensureKeyId(api, vault, bootstrap)
  return vault
}

// DATA-2: the session expired while the vault stayed open. Signing in again
// restores the cookie without touching the vault or the editor.
export async function reauthenticate({ api, email, password, argon2id = defaultArgon2id }) {
  const preloginData = await prelogin(api, email)
  if (preloginData.authMode !== 'e2ee') {
    throw new Error('This account is not encrypted')
  }
  const { authSecret } = await derivePasswordMaterial(password, preloginData.salt, preloginData.kdfParams, {
    argon2id,
  })
  return api.post('/api/auth/login', { email, authSecret })
}

async function currentPasswordMaterial(bootstrap, password, argon2id) {
  const material = await derivePasswordMaterial(password, bootstrap.salt, bootstrap.kdfParams, { argon2id })
  let raw
  try {
    raw = await unwrapVaultKey(material.kek, bootstrap.wrappedVaultKey, CONTEXTS.vaultKeyPassword)
  } catch {
    throw new Error('Your current password is incorrect')
  }
  return { authSecret: material.authSecret, raw }
}

// Password change: re-wraps the same vault key under the new password with
// current KDF defaults. The recovery key is untouched (CRYPTO-4); other
// sessions are signed out by the server.
export async function changePassword({ api, bootstrap, currentPassword, newPassword, argon2id = defaultArgon2id }) {
  assertPasswordStrength(newPassword)
  const { authSecret, raw } = await currentPasswordMaterial(bootstrap, currentPassword, argon2id)
  try {
    const keyId = bootstrap.vaultKeyId || (await keyFingerprint(raw))
    const wrapping = await createPasswordWrapping(newPassword, raw, keyId, { argon2id, kdfParams: DEFAULT_KDF_PARAMS })
    return await api.post('/api/auth/rekey', { currentAuthSecret: authSecret, ...wrapping })
  } finally {
    raw.fill(0)
  }
}

/**
 * CRYPTO-2 / CRYPTO-4: two-phase recovery key replacement. Phase one
 * produces the new key for the user to save; only `commit()` - called after
 * they confirm - makes it active. Until then the old key keeps working.
 */
export async function prepareNewRecoveryKey({ api, bootstrap, password, argon2id = defaultArgon2id }) {
  const { authSecret, raw } = await currentPasswordMaterial(bootstrap, password, argon2id)
  try {
    const keyId = bootstrap.vaultKeyId || (await keyFingerprint(raw))
    const recovery = await createRecoveryWrapping(raw, keyId)
    return {
      recoveryKey: recovery.recoveryKey,
      commit: () =>
        api.post('/api/auth/recovery-key', {
          currentAuthSecret: authSecret,
          recoveryVerifier: recovery.recoveryVerifier,
          wrappedVaultKeyRecovery: recovery.wrappedVaultKeyRecovery,
        }),
    }
  } finally {
    raw.fill(0)
  }
}

/**
 * Forgotten password. Phase one verifies the recovery key and prepares a new
 * password and a new recovery key (the used one may have been exposed while
 * typing it); `commit()` applies both once the new key is acknowledged.
 */
export async function prepareRecovery({ api, email, recoveryKey, newPassword, argon2id = defaultArgon2id }) {
  assertPasswordStrength(newPassword)
  const normalizedKey = normalizeRecoveryKey(recoveryKey)
  const recoveryVerifier = await deriveRecoveryVerifier(normalizedKey)
  const begin = await api.post('/api/auth/recover/begin', { email, recoveryVerifier })

  let raw
  try {
    raw = await unwrapVaultKey(
      await deriveRecoveryWrappingKey(normalizedKey),
      begin.wrappedVaultKeyRecovery,
      CONTEXTS.vaultKeyRecovery
    )
  } catch {
    throw new Error('Invalid recovery key')
  }

  const keyId = begin.vaultKeyId || (await keyFingerprint(raw))
  const passwordWrapping = await createPasswordWrapping(newPassword, raw, keyId, { argon2id })
  const nextRecovery = await createRecoveryWrapping(raw, keyId)

  return {
    recoveryKey: nextRecovery.recoveryKey,
    async commit() {
      const data = await api.post('/api/auth/recover', {
        email,
        recoveryVerifier,
        ...passwordWrapping,
        nextRecoveryVerifier: nextRecovery.recoveryVerifier,
        wrappedVaultKeyRecovery: nextRecovery.wrappedVaultKeyRecovery,
      })
      const vault = await openVaultFromBootstrap(raw, data.vaultBootstrap)
      await ensureKeyId(api, vault, data.vaultBootstrap)
      return { data, vault }
    },
    cancel() {
      raw.fill(0)
    },
  }
}

// SEC-6: deleting the account needs the password, not just the session.
export async function deleteAccount({ api, bootstrap, password, argon2id = defaultArgon2id }) {
  const { authSecret, raw } = await currentPasswordMaterial(bootstrap, password, argon2id)
  raw.fill(0)
  return api.delete('/api/users/account', { confirm: 'DELETE', currentAuthSecret: authSecret })
}
