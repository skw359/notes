import { concatBytes, decodeBase64, encodeBase64, encodeBase64Url } from './base64.js'

// Wire formats (see docs/CRYPTOGRAPHY.md):
//   v1  AES-256-GCM, no associated data (legacy, read-only)
//   v2  AAD = context string (read-only)
//   v3  AAD = JSON ["notes-envelope-v3", keyId, context, revision|null]
// Every ciphertext names the slot it belongs to, so the server cannot move
// it to another note or field, and v3 additionally names the key and, for
// note bodies, the revision (rollback detection).
export const ENVELOPE_ALGORITHM = 'AES-256-GCM'
export const CURRENT_ENVELOPE_VERSION = 3
export const MIN_PASSWORD_LENGTH = 12

export const CONTEXTS = {
  vaultKeyPassword: 'vault-key:password',
  vaultKeyRecovery: 'vault-key:recovery',
  profile: 'profile',
  blobV2: 'blob',
  keyring: (keyId) => `vault-keyring:${keyId}`,
  noteContent: (noteId) => `note-content:${noteId}`,
  noteSummary: (noteId) => `note-summary:${noteId}`,
  noteSearch: (noteId) => `note-search:${noteId}`,
}

export const DEFAULT_KDF_PARAMS = Object.freeze({
  algorithm: 'argon2id',
  time: 3,
  mem: 65536,
  hashLen: 32,
  parallelism: 1,
})

// Minimums match the original launch defaults so vaults created under them
// still unlock; anything below is a downgrade the client must refuse.
const KDF_BOUNDS = {
  time: { min: 2, max: 10 },
  mem: { min: 19456, max: 1 << 20 },
  parallelism: { min: 1, max: 4 },
}

const BLOB_CHUNK_BYTES = 1024 * 1024
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export class EnvelopeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'EnvelopeError'
    this.code = code
  }
}

// OPS-1: the old message blamed the browser; the usual cause is plain HTTP.
export function assertCryptoSupport() {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'This app must be served over HTTPS (or opened on localhost). Browsers only allow encryption on secure connections.'
    )
  }
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function assertBounded(value, { min, max }, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Refusing unsafe key derivation parameter: ${label}`)
  }
}

export function sanitizeKdfParams(kdfParams) {
  const params = { ...DEFAULT_KDF_PARAMS, ...(kdfParams || {}) }
  if (params.algorithm !== 'argon2id') {
    throw new Error('Unsupported key derivation algorithm')
  }
  if (params.hashLen !== 32) {
    throw new Error('Refusing unsafe key derivation parameter: hashLen')
  }
  assertBounded(params.time, KDF_BOUNDS.time, 'time')
  assertBounded(params.mem, KDF_BOUNDS.mem, 'mem')
  assertBounded(params.parallelism, KDF_BOUNDS.parallelism, 'parallelism')
  return {
    algorithm: params.algorithm,
    time: params.time,
    mem: params.mem,
    hashLen: params.hashLen,
    parallelism: params.parallelism,
  }
}

// Accounts created with the early floor parameters (or migrated from the
// legacy login) should re-key to the current defaults.
export function isWeakKdf(kdfParams) {
  return !kdfParams || kdfParams.mem < DEFAULT_KDF_PARAMS.mem || kdfParams.time < DEFAULT_KDF_PARAMS.time
}

export async function importAesKey(rawBytes) {
  assertCryptoSupport()
  // Non-extractable: script running in the page cannot read the key bytes back.
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function keyFingerprint(rawBytes) {
  const hmacKey = await crypto.subtle.importKey('raw', rawBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', hmacKey, textEncoder.encode('notes-vault-key-id-v1'))
  return encodeBase64Url(new Uint8Array(mac)).slice(0, 22)
}

export function envelopeAad(envelope) {
  if (envelope.version === 2) {
    return textEncoder.encode(envelope.context)
  }
  if (envelope.version === 3) {
    return textEncoder.encode(
      JSON.stringify(['notes-envelope-v3', envelope.keyId, envelope.context, envelope.revision ?? null])
    )
  }
  return null
}

export async function encryptEnvelope(key, bytes, { context, keyId, revision } = {}) {
  assertCryptoSupport()
  if (typeof context !== 'string' || !context) {
    throw new Error('An encryption context is required')
  }
  if (typeof keyId !== 'string' || !keyId) {
    throw new Error('A key id is required')
  }

  const iv = randomBytes(GCM_IV_BYTES)
  const envelope = { version: 3, algorithm: ENVELOPE_ALGORITHM, context, keyId }
  if (revision !== undefined) {
    envelope.revision = revision
  }
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: envelopeAad(envelope) },
    key,
    bytes
  )
  envelope.iv = encodeBase64(iv)
  envelope.ciphertext = encodeBase64(new Uint8Array(ciphertext))
  return envelope
}

// `keys` is a CryptoKey or anything with keyFor(keyId) / allKeys() (a Vault).
function candidateKeys(keys, envelope) {
  if (typeof keys?.keyFor === 'function') {
    if (envelope.version === 3) {
      const key = keys.keyFor(envelope.keyId)
      if (!key) {
        throw new EnvelopeError('UNKNOWN_KEY', 'This data was encrypted with a key this device does not have')
      }
      return [key]
    }
    return keys.allKeys()
  }
  return [keys]
}

/**
 * Decrypts any envelope version. `minVersion` enforces the account's
 * envelope floor (CRYPTO-5), `expectedRevision` the revision binding of note
 * bodies. Failures throw EnvelopeError with a stable code for diagnostics.
 */
export async function decryptEnvelope(keys, envelope, { context, minVersion = 1, expectedRevision } = {}) {
  assertCryptoSupport()
  if (!envelope || typeof envelope !== 'object') {
    throw new EnvelopeError('MALFORMED', 'Invalid encrypted envelope')
  }
  if (envelope.algorithm !== ENVELOPE_ALGORITHM) {
    throw new EnvelopeError('UNSUPPORTED_ALGORITHM', 'Unsupported envelope algorithm')
  }
  const version = Number(envelope.version)
  if (![1, 2, 3].includes(version)) {
    throw new EnvelopeError('UNSUPPORTED_VERSION', 'Unsupported envelope version')
  }
  if (version < minVersion) {
    throw new EnvelopeError('DOWNGRADE', 'This data uses an outdated format that this account no longer accepts')
  }
  if (version >= 2 && envelope.context !== context) {
    throw new EnvelopeError('CONTEXT_MISMATCH', 'Encrypted data does not match its expected context')
  }
  // An envelope without a revision is still authenticated as such (the AAD
  // carries null), so stripping the field cannot pass this check.
  if (version === 3 && expectedRevision !== undefined && envelope.revision !== undefined && envelope.revision !== expectedRevision) {
    throw new EnvelopeError('REVISION_MISMATCH', 'Encrypted data does not match the expected revision')
  }

  let iv
  let ciphertext
  try {
    iv = decodeBase64(envelope.iv)
    ciphertext = decodeBase64(envelope.ciphertext)
  } catch {
    throw new EnvelopeError('MALFORMED', 'Invalid encrypted envelope')
  }
  if (iv.length !== GCM_IV_BYTES || ciphertext.length < GCM_TAG_BYTES) {
    throw new EnvelopeError('MALFORMED', 'Invalid encrypted envelope')
  }

  const aad = envelopeAad({ ...envelope, version })
  const params = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv }
  for (const key of candidateKeys(keys, { ...envelope, version })) {
    try {
      return new Uint8Array(await crypto.subtle.decrypt(params, key, ciphertext))
    } catch {
      // try the next candidate (v1/v2 data predates key ids)
    }
  }
  throw new EnvelopeError('DECRYPT_FAILED', 'This data could not be decrypted (wrong key or corrupted)')
}

export async function encryptJson(key, value, options) {
  return encryptEnvelope(key, textEncoder.encode(JSON.stringify(value)), options)
}

export async function decryptJson(keys, envelope, options) {
  const bytes = await decryptEnvelope(keys, envelope, options)
  try {
    return JSON.parse(textDecoder.decode(bytes))
  } catch {
    throw new EnvelopeError('MALFORMED_PLAINTEXT', 'Decrypted data is not valid')
  }
}

// ── Password and recovery key material ─────────────────────────────────

async function hkdfBytes(masterBytes, saltBytes, info, length = 32) {
  const baseKey = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: textEncoder.encode(info) },
    baseKey,
    length * 8
  )
  return new Uint8Array(bits)
}

/**
 * password --Argon2id--> master --HKDF--> authSecret (sent to the server)
 *                               --HKDF--> KEK (wraps the vault key, never leaves)
 * `argon2id` is injected (a Web Worker in the app, a stub in unit tests).
 */
export async function derivePasswordMaterial(password, salt, kdfParams, { argon2id }) {
  assertCryptoSupport()
  const saltBytes = typeof salt === 'string' ? decodeBase64(salt) : salt
  const params = sanitizeKdfParams(kdfParams)
  const master = await argon2id({ password, salt: saltBytes, ...params })
  try {
    const authSecret = encodeBase64Url(await hkdfBytes(master, saltBytes, 'notes-auth-secret-v1'))
    const kekBytes = await hkdfBytes(master, saltBytes, 'notes-key-encryption-v1')
    const kek = await importAesKey(kekBytes)
    kekBytes.fill(0)
    return { authSecret, kek, kdfParams: params }
  } finally {
    master.fill(0)
  }
}

const RECOVERY_KEY_RE = /^[A-Za-z0-9_-]{32}$/

export function generateRecoveryKey() {
  return encodeBase64Url(randomBytes(24))
}

// Displayed in groups of four for readability; pasted keys may carry those
// spaces, line breaks or invisible characters (CRYPTO-4).
export function formatRecoveryKey(recoveryKey) {
  return String(recoveryKey).match(/.{1,4}/g)?.join(' ') ?? ''
}

export function normalizeRecoveryKey(input) {
  const normalized = String(input ?? '').replace(/[\s\u200B-\u200D\uFEFF]/g, '')
  if (!RECOVERY_KEY_RE.test(normalized)) {
    throw new Error('A recovery key has 32 letters, digits, "-" or "_" (spaces are ignored)')
  }
  return normalized
}

export async function deriveRecoveryWrappingKey(recoveryKey) {
  assertCryptoSupport()
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(`notes-recovery:${recoveryKey}`))
  const bytes = new Uint8Array(digest)
  try {
    return await importAesKey(bytes)
  } finally {
    bytes.fill(0)
  }
}

export async function deriveRecoveryVerifier(recoveryKey) {
  assertCryptoSupport()
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(`notes-recovery-verifier:${recoveryKey}`))
  return encodeBase64Url(new Uint8Array(digest))
}

export async function wrapVaultKey(wrappingKey, rawVaultKey, context, keyId) {
  return encryptEnvelope(wrappingKey, rawVaultKey, { context, keyId })
}

// Wrapped vault keys are exempt from the account's envelope floor: each copy
// is sealed under a different key (password KEK vs recovery key), so moving
// one into the other's slot cannot decrypt regardless of AAD, and the
// recovery copy can only be re-wrapped by someone holding the recovery key.
export async function unwrapVaultKey(wrappingKey, envelope, context) {
  const raw = await decryptEnvelope(wrappingKey, envelope, { context, minVersion: 1 })
  if (raw.length !== 32) {
    raw.fill(0)
    throw new EnvelopeError('MALFORMED', 'Unexpected vault key length')
  }
  return raw
}

export async function createPasswordWrapping(password, rawVaultKey, keyId, { argon2id, kdfParams = DEFAULT_KDF_PARAMS }) {
  const saltBytes = randomBytes(16)
  const { authSecret, kek, kdfParams: params } = await derivePasswordMaterial(password, saltBytes, kdfParams, {
    argon2id,
  })
  return {
    authSalt: encodeBase64(saltBytes),
    kdfParams: params,
    authVerifier: authSecret,
    wrappedVaultKey: await wrapVaultKey(kek, rawVaultKey, CONTEXTS.vaultKeyPassword, keyId),
  }
}

export async function createRecoveryWrapping(rawVaultKey, keyId) {
  const recoveryKey = generateRecoveryKey()
  const recoveryWrappingKey = await deriveRecoveryWrappingKey(recoveryKey)
  return {
    recoveryKey,
    recoveryVerifier: await deriveRecoveryVerifier(recoveryKey),
    wrappedVaultKeyRecovery: await wrapVaultKey(recoveryWrappingKey, rawVaultKey, CONTEXTS.vaultKeyRecovery, keyId),
  }
}

// ── Attachments ─────────────────────────────────────────────────────────

export function generateBlobUuid() {
  return encodeBase64Url(randomBytes(16))
}

function blobChunkAad(keyId, blobUuid, index, isLast) {
  return textEncoder.encode(JSON.stringify(['notes-blob-v3', keyId, blobUuid, index, isLast]))
}

/**
 * v3 attachment format: 1 MiB plaintext chunks, each stored as
 * IV (12) || ciphertext || tag (16). The AAD binds the key, the blob's
 * client-generated UUID (recorded inside the encrypted note, CRYPTO-5), the
 * chunk index and whether it is the last chunk, so chunks cannot be swapped,
 * reordered, truncated or moved to another attachment. Raw bytes throughout:
 * no base64 round trip (PERF-2).
 */
export async function encryptBlobV3(key, keyId, blobUuid, bytes) {
  const plaintext = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const chunkCount = Math.max(1, Math.ceil(plaintext.length / BLOB_CHUNK_BYTES))
  const parts = []
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = plaintext.subarray(index * BLOB_CHUNK_BYTES, (index + 1) * BLOB_CHUNK_BYTES)
    const iv = randomBytes(GCM_IV_BYTES)
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: blobChunkAad(keyId, blobUuid, index, index === chunkCount - 1) },
      key,
      chunk
    )
    parts.push(iv, new Uint8Array(sealed))
  }
  return concatBytes(parts)
}

export async function decryptBlobV3(key, keyId, blobUuid, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const fullChunk = GCM_IV_BYTES + BLOB_CHUNK_BYTES + GCM_TAG_BYTES
  const parts = []
  let offset = 0
  let index = 0
  while (offset < bytes.length) {
    const size = Math.min(fullChunk, bytes.length - offset)
    const isLast = offset + size === bytes.length
    if (size < GCM_IV_BYTES + GCM_TAG_BYTES || (!isLast && size !== fullChunk)) {
      throw new EnvelopeError('MALFORMED', 'Attachment data is truncated')
    }
    const iv = bytes.subarray(offset, offset + GCM_IV_BYTES)
    const sealed = bytes.subarray(offset + GCM_IV_BYTES, offset + size)
    try {
      parts.push(
        new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, additionalData: blobChunkAad(keyId, blobUuid, index, isLast) },
            key,
            sealed
          )
        )
      )
    } catch {
      throw new EnvelopeError('DECRYPT_FAILED', 'This attachment could not be decrypted (wrong key or tampered)')
    }
    offset += size
    index += 1
  }
  if (!parts.length) {
    throw new EnvelopeError('MALFORMED', 'Attachment data is empty')
  }
  return concatBytes(parts)
}

// v1/v2 attachments: one GCM message, IV from the server header.
export async function decryptLegacyBlob(keys, data, { version, iv }) {
  const ivBytes = decodeBase64(iv || '')
  if (ivBytes.length !== GCM_IV_BYTES) {
    throw new EnvelopeError('MALFORMED', 'Attachment is missing its IV')
  }
  const params =
    version === 2
      ? { name: 'AES-GCM', iv: ivBytes, additionalData: textEncoder.encode(CONTEXTS.blobV2) }
      : { name: 'AES-GCM', iv: ivBytes }
  const list = typeof keys?.allKeys === 'function' ? keys.allKeys() : [keys]
  for (const key of list) {
    try {
      return new Uint8Array(await crypto.subtle.decrypt(params, key, data))
    } catch {
      // next candidate
    }
  }
  throw new EnvelopeError('DECRYPT_FAILED', 'This attachment could not be decrypted')
}
