import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CONTEXTS, encryptJson, importAesKey, keyFingerprint, wrapVaultKey } from './envelope.js'
import { Vault } from './vault.js'

function rawKey() {
  return crypto.getRandomValues(new Uint8Array(32))
}

describe('Vault', () => {
  it('zeroes the raw key it was opened with and cannot hand it back', async () => {
    const raw = rawKey()
    const copy = raw.slice()
    const vault = await Vault.open(raw)
    expect(raw.every((byte) => byte === 0)).toBe(true)
    expect(vault.currentKeyId).toBe(await keyFingerprint(copy))
    expect(vault.currentKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', vault.currentKey)).rejects.toThrow()
  })

  it('reads data under previous keys from the keyring during a rotation', async () => {
    const oldRaw = rawKey()
    const oldKeyId = await keyFingerprint(oldRaw)
    const oldKey = await importAesKey(oldRaw.slice())
    const oldEnvelope = await encryptJson(oldKey, { from: 'old key' }, { context: 'note-content:1', keyId: oldKeyId })

    const newRaw = rawKey()
    const newKeyId = await keyFingerprint(newRaw)
    const newKey = await importAesKey(newRaw.slice())
    const keyring = { [oldKeyId]: await wrapVaultKey(newKey, oldRaw, CONTEXTS.keyring(oldKeyId), newKeyId) }

    const vault = await Vault.open(newRaw, { keyring })
    expect(vault.hasPreviousKeys).toBe(true)
    expect(await vault.decryptJson(oldEnvelope, 'note-content:1')).toEqual({ from: 'old key' })
    expect(vault.needsUpgrade(oldEnvelope)).toBe(true)

    const fresh = await vault.encryptJson({ from: 'new key' }, 'note-content:1', { revision: 2 })
    expect(fresh.keyId).toBe(newKeyId)
    expect(vault.needsUpgrade(fresh)).toBe(false)
  })

  it('rejects a keyring entry that does not match its id', async () => {
    const newRaw = rawKey()
    const newKeyId = await keyFingerprint(newRaw)
    const newKey = await importAesKey(newRaw.slice())
    const keyring = { claimedkeyid0000000000: await wrapVaultKey(newKey, rawKey(), CONTEXTS.keyring('claimedkeyid0000000000'), newKeyId) }
    await expect(Vault.open(newRaw, { keyring })).rejects.toMatchObject({ code: 'KEYRING_MISMATCH' })
  })

  it('enforces the account envelope floor', async () => {
    const raw = rawKey()
    const nodeKey = Buffer.from(raw)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', nodeKey, iv)
    const sealed = Buffer.concat([cipher.update('"legacy"'), cipher.final(), cipher.getAuthTag()])
    const v1 = { version: 1, algorithm: 'AES-256-GCM', iv: iv.toString('base64'), ciphertext: sealed.toString('base64') }

    const lenient = await Vault.open(raw.slice(), { minEnvelopeVersion: 1 })
    expect(await lenient.decryptJson(v1, 'profile')).toBe('legacy')
    const strict = await Vault.open(raw.slice(), { minEnvelopeVersion: 3 })
    await expect(strict.decryptJson(v1, 'profile')).rejects.toMatchObject({ code: 'DOWNGRADE' })
  })

  it('decrypts attachments by the reference stored in the note, not by server headers', async () => {
    const vault = await Vault.open(rawKey())
    const sealed = await vault.encryptBlob(new TextEncoder().encode('photo'))
    const reference = { blobUuid: sealed.blobUuid, blobVersion: 3, keyId: sealed.keyId }

    const opened = await vault.decryptBlob(sealed.data, reference, { version: '1', iv: 'AAAAAAAAAAAAAAAA' })
    expect(new TextDecoder().decode(opened)).toBe('photo')

    // A server swapping in another attachment of the same user fails.
    const other = await vault.encryptBlob(new TextEncoder().encode('other'))
    await expect(vault.decryptBlob(other.data, reference)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' })
  })
})
