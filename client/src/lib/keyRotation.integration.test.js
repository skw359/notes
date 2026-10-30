import { createCipheriv, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDevice, fastArgon2, startServer } from '../test/serverHarness.js'
import { decryptProfile, loginEncrypted, prelogin, signup } from './account.js'
import { fetchAttachmentBytes, uploadAttachment } from './attachments.js'
import { CONTEXTS, createPasswordWrapping, createRecoveryWrapping, derivePasswordMaterial, keyFingerprint } from './envelope.js'
import { prepareKeyRotation, reencryptVault } from './keyRotation.js'
import { createE2EECodec } from './noteCodecs.js'
import { collectBlobReferences, imageAttrsForBlob } from './noteContent.js'
import { createNoteStore } from './noteStore.js'
import { Vault } from './vault.js'

const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'rotated passphrase 2026'
let server

beforeAll(async () => {
  server = await startServer()
})

afterAll(async () => {
  await server.stop()
})

const doc = (text, extra = []) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...extra] })

async function settle(store, id) {
  for (let i = 0; i < 200; i += 1) {
    const state = store.getSnapshot().saveStates[id]?.state
    if (!state) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function login(email, password) {
  const device = createDevice(server.base)
  return { device, ...(await loginEncrypted({ api: device.api, email, password, preloginData: await prelogin(device.api, email), argon2id: fastArgon2 })) }
}

describe('CRYPTO-1 / CRYPTO-5: key rotation and format upgrade', () => {
  it('rotates the vault key, re-encrypts everything, and retires the old key and v1 data', async () => {
    const device = createDevice(server.base)
    const email = `rotate-${Date.now()}@example.com`
    const rawKey = crypto.getRandomValues(new Uint8Array(32))
    const { data, vault } = await signup({ api: device.api, email, password: PASSWORD, firstName: 'R', lastName: 'K', argon2id: fastArgon2 })
    void rawKey

    const store = createNoteStore({ api: device.api, codec: createE2EECodec(vault), userId: data.user.id })
    await store.start()
    const image = await uploadAttachment({ api: device.api, vault, bytes: new TextEncoder().encode('IMG'), mimeType: 'image/png' })
    const withImage = await store.createNote({ content: doc('has image', [{ type: 'image', attrs: imageAttrsForBlob(image) }]) })
    const plain = await store.createNote({ content: doc('plain text') })
    await settle(store, withImage.id)
    await settle(store, plain.id)
    store.updateNote(plain.id, doc('plain text v2'))
    await settle(store, plain.id)
    store.stop()

    const otherDevice = await login(email, PASSWORD)

    const prepared = await prepareKeyRotation({
      api: device.api,
      bootstrap: data.vaultBootstrap,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      argon2id: fastArgon2,
    })
    const { vault: rotated, data: started } = await prepared.commit()
    expect(rotated.currentKeyId).not.toBe(vault.currentKeyId)
    expect(rotated.hasPreviousKeys).toBe(true)
    expect(Object.keys(started.vaultBootstrap.keyring)).toEqual([vault.currentKeyId])
    // Devices holding the old key were signed out.
    await expect(otherDevice.device.api.get('/api/notes')).rejects.toMatchObject({ status: 401 })

    const progress = []
    const result = await reencryptVault({ api: device.api, vault: rotated, onProgress: (p) => progress.push(p.phase) })
    expect(result.complete).toBe(true)
    expect(result.data.vaultBootstrap.minEnvelopeVersion).toBe(3)
    expect(result.data.vaultBootstrap.keyring).toEqual({})
    expect(progress).toContain('notes')

    // Everything is now v3 under the new key; the old key decrypts nothing.
    const rows = (await server.pool.query('SELECT * FROM notes WHERE user_id = $1', [data.user.id])).rows
    for (const row of rows) {
      expect(row.encrypted_content.version).toBe(3)
      expect(row.encrypted_content.keyId).toBe(rotated.currentKeyId)
      await expect(vault.decryptJson(row.encrypted_content, CONTEXTS.noteContent(row.id))).rejects.toThrow()
    }
    const historyRows = (await server.pool.query('SELECT encrypted_content FROM note_revisions WHERE user_id = $1', [data.user.id])).rows
    expect(historyRows.length).toBeGreaterThan(0)
    expect(historyRows.every((row) => row.encrypted_content.keyId === rotated.currentKeyId)).toBe(true)

    // The attachment was re-encrypted under the new key and still opens.
    const fresh = await login(email, NEW_PASSWORD)
    expect(fresh.vault.currentKeyId).toBe(rotated.currentKeyId)
    const imageRow = rows.find((row) => row.id === withImage.id)
    const content = await fresh.vault.decryptJson(imageRow.encrypted_content, CONTEXTS.noteContent(imageRow.id))
    const [reference] = collectBlobReferences(content).values()
    expect(reference.blobId).not.toBe(image.blobId)
    expect(reference.keyId).toBe(rotated.currentKeyId)
    const bytes = await fetchAttachmentBytes({ api: fresh.device.api, vault: fresh.vault, reference })
    expect(new TextDecoder().decode(bytes)).toBe('IMG')
  })

  it('upgrades a 1.x-shaped vault (v1 everything, no key id, floor KDF) to v3 under the same key', async () => {
    // Build the account the way 1.x clients left it, with a raw key we hold.
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const v1 = (bytes) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(raw), iv)
      const sealed = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
      return { iv: iv.toString('base64'), sealed, envelope: { version: 1, algorithm: 'AES-256-GCM', iv: iv.toString('base64'), ciphertext: sealed.toString('base64') } }
    }
    const floorKdf = { algorithm: 'argon2id', time: 2, mem: 19456, hashLen: 32, parallelism: 1 }
    const keyId = await keyFingerprint(raw.slice())
    const passwordWrapping = await createPasswordWrapping(PASSWORD, raw.slice(), keyId, { argon2id: fastArgon2, kdfParams: floorKdf })
    const recovery = await createRecoveryWrapping(raw.slice(), keyId)
    const email = `upgrade-${Date.now()}@example.com`
    const device = createDevice(server.base)
    const signupVault = await Vault.open(raw.slice())
    const created = await device.api.post('/api/auth/signup', {
      email,
      ...passwordWrapping,
      recoveryVerifier: recovery.recoveryVerifier,
      wrappedVaultKeyRecovery: recovery.wrappedVaultKeyRecovery,
      encryptedProfile: await signupVault.encryptJson({ first_name: 'x' }, CONTEXTS.profile),
    })
    const userId = created.user.id

    // Rewrite the rows into 1.x shape: v1 wrapped key, no key id, v1 notes,
    // a v1 attachment and a v1 profile pointing at it. The v1 wrapped key is
    // AES-GCM under the password KEK with no associated data.
    const { kek } = await derivePasswordMaterial(PASSWORD, passwordWrapping.authSalt, floorKdf, { argon2id: fastArgon2 })
    const wrapIv = crypto.getRandomValues(new Uint8Array(12))
    const wrappedBytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, kek, raw.slice()))
    const wrapped = {
      envelope: {
        version: 1,
        algorithm: 'AES-256-GCM',
        iv: Buffer.from(wrapIv).toString('base64'),
        ciphertext: Buffer.from(wrappedBytes).toString('base64'),
      },
    }
    const blob = v1(Buffer.from('PROFILE PICTURE'))
    const blobKey = `u${userId}-legacy.bin`
    await import('node:fs/promises').then((fsp) => fsp.writeFile(`${server.config.storage.blobsDir}/${blobKey}`, blob.sealed))
    const blobRow = await server.pool.query(
      `INSERT INTO blobs (user_id, kind, byte_length, storage_path, storage_key, envelope_iv, envelope_version)
       VALUES ($1, 'profile-picture', $2, $3, $3, $4, 1) RETURNING id`,
      [userId, blob.sealed.length, blobKey, blob.iv]
    )
    const pictureId = blobRow.rows[0].id
    const profile = v1(Buffer.from(JSON.stringify({ first_name: 'Live', last_name: 'User', profile_picture_blob_id: String(pictureId), profile_picture_mime_type: 'image/jpeg' })))
    await server.pool.query(
      `UPDATE users SET wrapped_vault_key = $2, vault_key_id = NULL, encrypted_profile = $3, profile_ref_known = FALSE WHERE id = $1`,
      [userId, JSON.stringify(wrapped.envelope), JSON.stringify(profile.envelope)]
    )
    const noteIds = []
    await server.pool.query('ALTER TABLE notes DISABLE TRIGGER notes_before_write')
    // The last one is in the trash: re-encryption must reach it and leave it there.
    for (const text of ['first v1 note', 'second v1 note', 'trashed v1 note']) {
      const content = v1(Buffer.from(JSON.stringify(doc(text)))).envelope
      const summary = v1(Buffer.from(JSON.stringify({ title: text, preview: '' }))).envelope
      const row = await server.pool.query(
        `INSERT INTO notes (user_id, encrypted_content, encrypted_summary, revision, blob_refs_known, deleted_at)
         VALUES ($1, $2, $3, 1, FALSE, $4) RETURNING id`,
        [userId, JSON.stringify(content), JSON.stringify(summary), text.startsWith('trashed') ? '2026-10-20T12:00:00Z' : null]
      )
      noteIds.push(row.rows[0].id)
    }
    await server.pool.query('ALTER TABLE notes ENABLE TRIGGER notes_before_write')

    // Logging in unwraps the v1 key and registers the key id.
    const session = await login(email, PASSWORD)
    expect(session.data.vaultBootstrap.vaultKeyId).toBe(keyId)
    expect((await server.pool.query('SELECT vault_key_id FROM users WHERE id = $1', [userId])).rows[0].vault_key_id).toBe(keyId)
    const status = await session.device.api.get('/api/vault/status')
    expect(status.pending.notes).toBe(3)
    expect(status.pending.profile).toBe(true)

    const result = await reencryptVault({ api: session.device.api, vault: session.vault })
    expect(result.pending ?? 'complete').toBe('complete')
    expect(result.complete).toBe(true)
    expect(result.data.vaultBootstrap.minEnvelopeVersion).toBe(3)

    for (const id of noteIds) {
      const row = (await server.pool.query('SELECT * FROM notes WHERE id = $1', [id])).rows[0]
      expect(row.encrypted_content).toMatchObject({ version: 3, keyId })
      expect(row.encrypted_summary).toMatchObject({ version: 3, keyId })
    }
    const trashed = (await server.pool.query('SELECT deleted_at FROM notes WHERE id = $1', [noteIds[2]])).rows[0]
    expect(trashed.deleted_at.toISOString()).toBe('2026-10-20T12:00:00.000Z')
    // The profile and its picture are v3 now and still decrypt.
    const after = await login(email, PASSWORD)
    const decrypted = await decryptProfile(after.vault, after.data.encryptedProfile)
    expect(decrypted.first_name).toBe('Live')
    expect(decrypted.profile_picture_blob_version).toBe(3)
    const bytes = await fetchAttachmentBytes({
      api: after.device.api,
      vault: after.vault,
      reference: {
        blobId: decrypted.profile_picture_blob_id,
        blobUuid: decrypted.profile_picture_blob_uuid,
        blobVersion: 3,
        keyId: decrypted.profile_picture_key_id,
      },
    })
    expect(new TextDecoder().decode(bytes)).toBe('PROFILE PICTURE')
    // From now on the account refuses v1/v2 data (downgrade protection).
    expect(after.vault.minEnvelopeVersion).toBe(3)
    await expect(after.vault.decryptJson(profile.envelope, CONTEXTS.profile)).rejects.toMatchObject({ code: 'DOWNGRADE' })
  })
})
