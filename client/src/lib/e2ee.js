import argon2 from 'argon2-browser/dist/argon2-bundled.min.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export const ENVELOPE_VERSION = 2
export const ENVELOPE_ALGORITHM = 'AES-256-GCM'
export const MIN_PASSWORD_LENGTH = 12

// Every ciphertext is bound to the context it was created for via AES-GCM
// additionalData, so the server cannot swap envelopes between slots (e.g.
// serve note A's content as note B's, or a summary as a content blob).
export const CONTEXTS = {
  vaultKeyPassword: 'vault-key:password',
  vaultKeyRecovery: 'vault-key:recovery',
  profile: 'profile',
  blob: 'blob',
  noteContent: (noteId) => `note-content:${noteId}`,
  noteSummary: (noteId) => `note-summary:${noteId}`,
  noteSearch: (noteId) => `note-search:${noteId}`,
}

const DEFAULT_ARGON2_PARAMS = {
  algorithm: 'argon2id',
  time: 3,
  mem: 65536,
  hashLen: 32,
  parallelism: 1,
}

// Minimums match the original launch defaults so vaults created under them
// still unlock; anything below is a downgrade the client must refuse.
const KDF_BOUNDS = {
  time: { min: 2, max: 10 },
  mem: { min: 19456, max: 1 << 20 },
  parallelism: { min: 1, max: 4 },
}

function assertBounded(value, { min, max }, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Refusing unsafe key derivation parameter: ${label}`)
  }
}

export function sanitizeKdfParams(kdfParams) {
  const params = {
    ...DEFAULT_ARGON2_PARAMS,
    ...(kdfParams || {}),
  }

  if (params.algorithm !== 'argon2id') {
    throw new Error('Unsupported key derivation algorithm')
  }
  if (params.hashLen !== 32) {
    throw new Error('Refusing unsafe key derivation parameter: hashLen')
  }
  assertBounded(params.time, KDF_BOUNDS.time, 'time')
  assertBounded(params.mem, KDF_BOUNDS.mem, 'mem')
  assertBounded(params.parallelism, KDF_BOUNDS.parallelism, 'parallelism')

  return params
}

function assertCryptoSupport() {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure crypto APIs are unavailable in this browser')
  }
}

export function encodeBase64(bytes) {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function decodeBase64(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function encodeBase64Url(bytes) {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return decodeBase64(`${normalized}${padding}`)
}

function randomBytes(length) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function bytesToString(bytes) {
  return textDecoder.decode(bytes)
}

function stringToBytes(value) {
  return textEncoder.encode(value)
}

async function deriveMasterKeyArgon2(password, saltBytes, params) {
  const result = await argon2.hash({
    pass: password,
    salt: saltBytes,
    time: params.time,
    mem: params.mem,
    hashLen: params.hashLen,
    parallelism: params.parallelism,
    type: argon2.ArgonType.Argon2id,
  })

  return new Uint8Array(result.hash)
}

async function hkdfBytes(masterBytes, saltBytes, info, length = 32) {
  const baseKey = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveBits'])
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes,
      info: stringToBytes(info),
    },
    baseKey,
    length * 8
  )

  return new Uint8Array(derivedBits)
}

async function importAesKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

export function createEmptyNoteContent() {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

export function generateRecoveryKey() {
  return encodeBase64Url(randomBytes(24))
}

export async function deriveRecoveryWrappingKey(recoveryKey) {
  assertCryptoSupport()
  const digest = await crypto.subtle.digest('SHA-256', stringToBytes(`notes-recovery:${recoveryKey}`))
  return new Uint8Array(digest)
}

export async function deriveRecoveryVerifier(recoveryKey) {
  assertCryptoSupport()
  const digest = await crypto.subtle.digest('SHA-256', stringToBytes(`notes-recovery-verifier:${recoveryKey}`))
  return encodeBase64Url(new Uint8Array(digest))
}

export async function derivePasswordMaterial(password, salt, kdfParams = DEFAULT_ARGON2_PARAMS) {
  assertCryptoSupport()
  const saltBytes = typeof salt === 'string' ? decodeBase64(salt) : salt
  const params = sanitizeKdfParams(kdfParams)

  const masterBytes = await deriveMasterKeyArgon2(password, saltBytes, params)
  const authSecretBytes = await hkdfBytes(masterBytes, saltBytes, 'notes-auth-secret-v1')
  const keyEncryptionKey = await hkdfBytes(masterBytes, saltBytes, 'notes-key-encryption-v1')

  return {
    authSecret: encodeBase64Url(authSecretBytes),
    keyEncryptionKey,
    kdfParams: params,
  }
}

export async function encryptBytes(keyBytes, bytes, context) {
  assertCryptoSupport()
  if (typeof context !== 'string' || !context) {
    throw new Error('An encryption context is required')
  }

  const iv = randomBytes(12)
  const key = await importAesKey(keyBytes)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: stringToBytes(context) },
    key,
    bytes
  )

  return {
    version: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    context,
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  }
}

export async function decryptBytes(keyBytes, envelope, expectedContext) {
  assertCryptoSupport()
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Invalid encrypted envelope')
  }
  if (envelope.algorithm !== ENVELOPE_ALGORITHM) {
    throw new Error('Unsupported envelope algorithm')
  }

  const version = Number(envelope.version)
  const iv = decodeBase64(envelope.iv)
  const ciphertext = decodeBase64(envelope.ciphertext)
  const key = await importAesKey(keyBytes)

  if (version === 1) {
    // Legacy envelopes predate context binding; decrypt without AAD so
    // existing data stays readable. Re-encryption upgrades them to v2.
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new Uint8Array(plaintext)
  }

  if (version !== ENVELOPE_VERSION) {
    throw new Error('Unsupported envelope version')
  }
  if (typeof expectedContext !== 'string' || !expectedContext) {
    throw new Error('A decryption context is required')
  }
  if (envelope.context !== expectedContext) {
    throw new Error('Encrypted data does not match its expected context')
  }

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: stringToBytes(expectedContext) },
    key,
    ciphertext
  )
  return new Uint8Array(plaintext)
}

export async function encryptJson(keyBytes, value, context) {
  return encryptBytes(keyBytes, stringToBytes(JSON.stringify(value)), context)
}

export async function decryptJson(keyBytes, envelope, expectedContext) {
  const bytes = await decryptBytes(keyBytes, envelope, expectedContext)
  return JSON.parse(bytesToString(bytes))
}

export async function createVaultBootstrap(password, existingVaultKey = null) {
  const saltBytes = randomBytes(16)
  const salt = encodeBase64(saltBytes)
  const { authSecret, keyEncryptionKey, kdfParams } = await derivePasswordMaterial(password, saltBytes)
  const vaultKey = existingVaultKey || randomBytes(32)
  const recoveryKey = generateRecoveryKey()
  const recoveryWrappingKey = await deriveRecoveryWrappingKey(recoveryKey)

  return {
    authSalt: salt,
    authVerifier: authSecret,
    recoveryKey,
    recoveryVerifier: await deriveRecoveryVerifier(recoveryKey),
    kdfParams,
    vaultKey,
    wrappedVaultKey: await encryptBytes(keyEncryptionKey, vaultKey, CONTEXTS.vaultKeyPassword),
    wrappedVaultKeyRecovery: await encryptBytes(recoveryWrappingKey, vaultKey, CONTEXTS.vaultKeyRecovery),
  }
}

export async function unlockVaultWithPassword(password, vaultBootstrap) {
  const { authSecret, keyEncryptionKey } = await derivePasswordMaterial(
    password,
    vaultBootstrap.salt,
    vaultBootstrap.kdfParams
  )

  const vaultKey = await decryptBytes(
    keyEncryptionKey,
    vaultBootstrap.wrappedVaultKey,
    CONTEXTS.vaultKeyPassword
  )
  return { authSecret, vaultKey }
}

export async function unlockVaultWithRecoveryKey(recoveryKey, wrappedVaultKeyRecovery) {
  const recoveryWrappingKey = await deriveRecoveryWrappingKey(recoveryKey)
  return decryptBytes(recoveryWrappingKey, wrappedVaultKeyRecovery, CONTEXTS.vaultKeyRecovery)
}

export async function encryptProfile(keyBytes, profile) {
  return encryptJson(keyBytes, profile, CONTEXTS.profile)
}

export async function decryptProfile(keyBytes, encryptedProfile) {
  return decryptJson(keyBytes, encryptedProfile, CONTEXTS.profile)
}
