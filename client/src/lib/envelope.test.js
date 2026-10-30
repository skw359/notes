import { createCipheriv, createHmac, randomBytes as nodeRandomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeBase64, encodeBase64, encodeBase64Url } from './base64.js'
import {
  CONTEXTS,
  createPasswordWrapping,
  createRecoveryWrapping,
  decryptBlobV3,
  decryptEnvelope,
  decryptJson,
  decryptLegacyBlob,
  derivePasswordMaterial,
  deriveRecoveryVerifier,
  deriveRecoveryWrappingKey,
  encryptBlobV3,
  encryptEnvelope,
  encryptJson,
  formatRecoveryKey,
  generateRecoveryKey,
  importAesKey,
  isWeakKdf,
  keyFingerprint,
  normalizeRecoveryKey,
  sanitizeKdfParams,
  unwrapVaultKey,
  wrapVaultKey,
} from './envelope.js'

// Argon2id outputs computed with the native reference implementation
// (node-argon2, which reproduces the RFC 9106 test vector). The browser's
// argon2-browser is checked against the same vectors in the E2E suite.
const KAT_PASSWORD = 'correct horse battery staple'
const KAT_SALT = Uint8Array.from(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'))
const KAT = [
  {
    params: { algorithm: 'argon2id', time: 3, mem: 65536, hashLen: 32, parallelism: 1 },
    master: '0d1a3c6523c8f06e4e0af9c515aa5b5448cfebd6838f2d52c3d8b6ef8ddc3c2e',
    authSecret: 'OEw1oxFO62l86gJAdh0X0BjOufpMd5Ym8adz1mFxPN0',
    kek: '54233c716c270f85ab7d4bc392fec319f2a8dde61152c2d50430f352f626fa3f',
  },
  {
    params: { algorithm: 'argon2id', time: 2, mem: 19456, hashLen: 32, parallelism: 1 },
    master: '818259b6310026a8e0dbac5d2e6927abcfdb07b32258fac4f61b18b80f929085',
    authSecret: 'ZWm8I0njzJjz1Mmss_z7vdiOTgxfax6Wav0KTzD86K8',
    kek: '78a4fe8dcdc2f47124970acd7c860449d317237a9f603376f9a87739895e4a8b',
  },
]

function katArgon2({ password, salt, mem, time }) {
  const vector = KAT.find((v) => v.params.mem === mem && v.params.time === time)
  if (password !== KAT_PASSWORD || Buffer.compare(Buffer.from(salt), Buffer.from(KAT_SALT)) !== 0 || !vector) {
    throw new Error('unexpected argon2 input')
  }
  return Promise.resolve(Uint8Array.from(Buffer.from(vector.master, 'hex')))
}

// Same construction the server tests use (independent implementation).
function nodeEncrypt(rawKey, plaintext, envelope) {
  const iv = nodeRandomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(rawKey), iv)
  if (envelope.version === 2) {
    cipher.setAAD(Buffer.from(envelope.context))
  }
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return { ...envelope, iv: iv.toString('base64'), ciphertext: sealed.toString('base64') }
}

async function freshKey() {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  return { raw: raw.slice(), key: await importAesKey(raw), keyId: await keyFingerprint(raw) }
}

describe('key derivation', () => {
  it('matches the known-answer vectors (Argon2id -> HKDF)', async () => {
    for (const vector of KAT) {
      const material = await derivePasswordMaterial(KAT_PASSWORD, KAT_SALT, vector.params, { argon2id: katArgon2 })
      expect(material.authSecret).toBe(vector.authSecret)
      // The KEK is non-extractable; prove it is the expected key by decrypting
      // something encrypted under the vector's KEK.
      const expectedKek = Buffer.from(vector.kek, 'hex')
      const probe = nodeEncrypt(expectedKek, Buffer.from('probe'), { version: 2, algorithm: 'AES-256-GCM', context: 'probe' })
      const opened = await decryptEnvelope(material.kek, probe, { context: 'probe' })
      expect(Buffer.from(opened).toString()).toBe('probe')
    }
  })

  it('refuses downgraded KDF parameters from the server', () => {
    expect(() => sanitizeKdfParams({ mem: 1024 })).toThrow(/mem/)
    expect(() => sanitizeKdfParams({ time: 1 })).toThrow(/time/)
    expect(() => sanitizeKdfParams({ algorithm: 'argon2i' })).toThrow(/algorithm/)
    expect(() => sanitizeKdfParams({ hashLen: 16 })).toThrow(/hashLen/)
    expect(() => sanitizeKdfParams({ parallelism: 0 })).toThrow(/parallelism/)
    expect(sanitizeKdfParams({ mem: 19456, time: 2 })).toMatchObject({ mem: 19456, time: 2 })
  })

  it('flags weak (floor) parameters for an upgrade', () => {
    expect(isWeakKdf({ mem: 19456, time: 2 })).toBe(true)
    expect(isWeakKdf({ mem: 65536, time: 3 })).toBe(false)
  })
})

describe('envelopes', () => {
  it('round-trips v3 JSON and binds context, key and revision', async () => {
    const { key, keyId } = await freshKey()
    const envelope = await encryptJson(key, { hello: 'world' }, { context: CONTEXTS.noteContent(7), keyId, revision: 3 })
    expect(envelope).toMatchObject({ version: 3, context: 'note-content:7', keyId, revision: 3 })
    expect(await decryptJson(key, envelope, { context: 'note-content:7', expectedRevision: 3 })).toEqual({ hello: 'world' })

    await expect(decryptJson(key, envelope, { context: 'note-content:8' })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' })
    await expect(decryptJson(key, envelope, { context: 'note-content:7', expectedRevision: 4 })).rejects.toMatchObject({
      code: 'REVISION_MISMATCH',
    })
    // Relabeling the envelope cannot defeat the AAD binding.
    for (const forged of [
      { ...envelope, context: 'note-content:8' },
      { ...envelope, revision: 9 },
      { ...envelope, keyId: 'otherkeyid000000000000' },
    ]) {
      await expect(decryptJson(key, forged, { context: forged.context })).rejects.toMatchObject({ code: 'DECRYPT_FAILED' })
    }
  })

  it('detects tampering with the IV, ciphertext or tag', async () => {
    const { key, keyId } = await freshKey()
    const envelope = await encryptJson(key, 'secret', { context: 'profile', keyId })
    const bytes = decodeBase64(envelope.ciphertext)
    const flip = (index) => {
      const copy = bytes.slice()
      copy[index] ^= 1
      return encodeBase64(copy)
    }
    const iv = decodeBase64(envelope.iv)
    iv[0] ^= 1
    for (const tampered of [
      { ...envelope, ciphertext: flip(0) },
      { ...envelope, ciphertext: flip(bytes.length - 1) },
      { ...envelope, iv: encodeBase64(iv) },
    ]) {
      await expect(decryptJson(key, tampered, { context: 'profile' })).rejects.toMatchObject({ code: 'DECRYPT_FAILED' })
    }
  })

  it('uses a fresh IV for every encryption', async () => {
    const { key, keyId } = await freshKey()
    const ivs = new Set()
    for (let i = 0; i < 10000; i += 1) {
      ivs.add((await encryptEnvelope(key, new Uint8Array(1), { context: 'c', keyId })).iv)
    }
    expect(ivs.size).toBe(10000)
  })

  it('still decrypts v1 (no AAD) and v2 (context AAD) envelopes written by older clients', async () => {
    const { raw, key } = await freshKey()
    const v1 = nodeEncrypt(raw, Buffer.from(JSON.stringify({ legacy: 1 })), { version: 1, algorithm: 'AES-256-GCM' })
    const v2 = nodeEncrypt(raw, Buffer.from(JSON.stringify({ legacy: 2 })), {
      version: 2,
      algorithm: 'AES-256-GCM',
      context: 'note-content:5',
    })
    expect(await decryptJson(key, v1, { context: 'note-content:5' })).toEqual({ legacy: 1 })
    expect(await decryptJson(key, v2, { context: 'note-content:5' })).toEqual({ legacy: 2 })
    await expect(decryptJson(key, v2, { context: 'note-content:6' })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' })
  })

  it('refuses v1/v2 data once the account requires v3 (CRYPTO-5 downgrade)', async () => {
    const { raw, key } = await freshKey()
    const v1 = nodeEncrypt(raw, Buffer.from('"x"'), { version: 1, algorithm: 'AES-256-GCM' })
    await expect(decryptJson(key, v1, { context: 'profile', minVersion: 3 })).rejects.toMatchObject({ code: 'DOWNGRADE' })
  })

  it('rejects malformed envelopes with diagnosable codes', async () => {
    const { key } = await freshKey()
    await expect(decryptEnvelope(key, null, { context: 'x' })).rejects.toMatchObject({ code: 'MALFORMED' })
    await expect(decryptEnvelope(key, { version: 9, algorithm: 'AES-256-GCM' }, { context: 'x' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    })
    await expect(decryptEnvelope(key, { version: 3, algorithm: 'DES' }, { context: 'x' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_ALGORITHM',
    })
  })

  it('computes the same key fingerprint as the server test helper', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const expected = createHmac('sha256', Buffer.from(raw)).update('notes-vault-key-id-v1').digest('base64url').slice(0, 22)
    expect(await keyFingerprint(raw)).toBe(expected)
  })
})

describe('vault key wrapping and recovery keys', () => {
  it('wraps and unwraps the vault key with password and recovery material', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const keyId = await keyFingerprint(raw)
    const password = await createPasswordWrapping(KAT_PASSWORD, raw, keyId, {
      argon2id: async () => crypto.getRandomValues(new Uint8Array(32)),
    })
    expect(password.wrappedVaultKey).toMatchObject({ version: 3, context: CONTEXTS.vaultKeyPassword, keyId })

    const recovery = await createRecoveryWrapping(raw, keyId)
    const rwk = await deriveRecoveryWrappingKey(normalizeRecoveryKey(formatRecoveryKey(recovery.recoveryKey)))
    const unwrapped = await unwrapVaultKey(rwk, recovery.wrappedVaultKeyRecovery, CONTEXTS.vaultKeyRecovery)
    expect(Buffer.compare(Buffer.from(unwrapped), Buffer.from(raw))).toBe(0)
    expect(recovery.recoveryVerifier).toBe(await deriveRecoveryVerifier(recovery.recoveryKey))

    // A recovery-wrapped key cannot be passed off as the password-wrapped one.
    await expect(unwrapVaultKey(rwk, recovery.wrappedVaultKeyRecovery, CONTEXTS.vaultKeyPassword)).rejects.toThrow()
  })

  it('keeps the existing recovery-key derivations (old keys must keep working)', async () => {
    const key = 'abcdefghijklmnopqrstuvwxyz012345'
    const verifier = encodeBase64Url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`notes-recovery-verifier:${key}`)))
    )
    expect(await deriveRecoveryVerifier(key)).toBe(verifier)
    const rawRwk = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`notes-recovery:${key}`)))
    const wrapped = nodeEncrypt(rawRwk, Buffer.alloc(32, 7), {
      version: 2,
      algorithm: 'AES-256-GCM',
      context: CONTEXTS.vaultKeyRecovery,
    })
    const unwrapped = await unwrapVaultKey(await deriveRecoveryWrappingKey(key), wrapped, CONTEXTS.vaultKeyRecovery)
    expect(Buffer.from(unwrapped).equals(Buffer.alloc(32, 7))).toBe(true)
  })

  it('normalizes pasted recovery keys and rejects malformed ones', () => {
    const key = generateRecoveryKey()
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const formatted = formatRecoveryKey(key)
    expect(formatted.split(' ')).toHaveLength(8)
    expect(normalizeRecoveryKey(`  ${formatted}\n`)).toBe(key)
    expect(normalizeRecoveryKey(`\u200B${key}\uFEFF`)).toBe(key)
    expect(() => normalizeRecoveryKey('too-short')).toThrow(/32/)
    expect(() => normalizeRecoveryKey(`${key}!`)).toThrow()
  })

  it('wrapVaultKey binds the key id', async () => {
    const { key, keyId } = await freshKey()
    const wrapped = await wrapVaultKey(key, new Uint8Array(32), CONTEXTS.keyring('old'), keyId)
    expect(wrapped.keyId).toBe(keyId)
  })
})

describe('attachments (v3 chunked format)', () => {
  it('round-trips small and multi-chunk files', async () => {
    const { key, keyId } = await freshKey()
    for (const size of [0, 1, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024 + 17]) {
      const bytes = crypto.getRandomValues(new Uint8Array(Math.min(size, 65536)))
      const data = size > 65536 ? new Uint8Array(size).map((_, i) => i % 251) : bytes
      const sealed = await encryptBlobV3(key, keyId, 'uuid-1', data)
      const opened = await decryptBlobV3(key, keyId, 'uuid-1', sealed)
      expect(opened.length).toBe(data.length)
      expect(Buffer.compare(Buffer.from(opened), Buffer.from(data))).toBe(0)
    }
  })

  it('detects truncation, chunk reordering and swapping attachments', async () => {
    const { key, keyId } = await freshKey()
    const data = new Uint8Array(2 * 1024 * 1024 + 10).map((_, i) => i % 7)
    const sealed = await encryptBlobV3(key, keyId, 'uuid-a', data)
    const chunk = 12 + 1024 * 1024 + 16

    // Dropping the last chunk leaves a non-final chunk at the end.
    await expect(decryptBlobV3(key, keyId, 'uuid-a', sealed.subarray(0, 2 * chunk))).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    })
    const swapped = new Uint8Array(sealed)
    swapped.set(sealed.subarray(chunk, 2 * chunk), 0)
    swapped.set(sealed.subarray(0, chunk), chunk)
    await expect(decryptBlobV3(key, keyId, 'uuid-a', swapped)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' })
    // The same bytes served for a different attachment reference fail.
    await expect(decryptBlobV3(key, keyId, 'uuid-b', sealed)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' })
  })

  it('still decrypts v1 and v2 attachments', async () => {
    const { raw, key } = await freshKey()
    for (const version of [1, 2]) {
      const iv = nodeRandomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(raw), iv)
      if (version === 2) {
        cipher.setAAD(Buffer.from('blob'))
      }
      const sealed = Buffer.concat([cipher.update(Buffer.from('image bytes')), cipher.final(), cipher.getAuthTag()])
      const opened = await decryptLegacyBlob(key, new Uint8Array(sealed), { version, iv: iv.toString('base64') })
      expect(Buffer.from(opened).toString()).toBe('image bytes')
    }
  })
})
