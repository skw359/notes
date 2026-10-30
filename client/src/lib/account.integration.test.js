import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDevice, fastArgon2, startServer } from '../test/serverHarness.js'
import { insertLegacyNote, insertLegacyUser } from '../../../server/test/helpers/testApp.js'
import {
  changePassword,
  decryptProfile,
  deleteAccount,
  loginEncrypted,
  prelogin,
  prepareNewRecoveryKey,
  prepareRecovery,
  signup,
} from './account.js'
import { CONTEXTS } from './envelope.js'
import { fetchAttachmentBytes } from './attachments.js'
import { migrateLegacyAccount } from './legacyMigration.js'
import { collectBlobReferences, parseAttachmentHref } from './noteContent.js'

const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a completely new passphrase'
let server
let count = 0

beforeAll(async () => {
  server = await startServer()
})

afterAll(async () => {
  await server.stop()
})

async function freshAccount() {
  count += 1
  const device = createDevice(server.base)
  const email = `acct-${Date.now()}-${count}@example.com`
  const result = await signup({ api: device.api, email, password: PASSWORD, firstName: 'Ada', lastName: 'L', argon2id: fastArgon2 })
  return { device, email, ...result }
}

async function login(email, password) {
  const device = createDevice(server.base)
  const result = await loginEncrypted({
    api: device.api,
    email,
    password,
    preloginData: await prelogin(device.api, email),
    argon2id: fastArgon2,
  })
  return { device, ...result }
}

describe('account flows', () => {
  it('signup stores only ciphertext and the profile decrypts on another device', async () => {
    const account = await freshAccount()
    const row = (await server.pool.query('SELECT * FROM users WHERE id = $1', [account.data.user.id])).rows[0]
    expect(JSON.stringify(row)).not.toMatch(/Ada/)
    const other = await login(account.email, PASSWORD)
    expect(await decryptProfile(other.vault, other.data.encryptedProfile)).toMatchObject({ first_name: 'Ada' })
  })

  it('a password change keeps the existing recovery key working (CRYPTO-4)', async () => {
    const account = await freshAccount()
    await changePassword({
      api: account.device.api,
      bootstrap: account.data.vaultBootstrap,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      argon2id: fastArgon2,
    })
    await expect(login(account.email, PASSWORD)).rejects.toThrow()
    expect((await login(account.email, NEW_PASSWORD)).vault.currentKeyId).toBe(account.vault.currentKeyId)

    // The original recovery key still unlocks the vault.
    const device = createDevice(server.base)
    const recovery = await prepareRecovery({
      api: device.api,
      email: account.email,
      recoveryKey: account.recoveryKey,
      newPassword: 'recovered passphrase!!',
      argon2id: fastArgon2,
    })
    recovery.cancel()
  })

  it('regenerating the recovery key is two-phase: the old key works until commit', async () => {
    const account = await freshAccount()
    const prepared = await prepareNewRecoveryKey({
      api: account.device.api,
      bootstrap: account.data.vaultBootstrap,
      password: PASSWORD,
      argon2id: fastArgon2,
    })
    // Not committed yet: the old key still verifies.
    const probe = createDevice(server.base)
    const stillOld = await prepareRecovery({ api: probe.api, email: account.email, recoveryKey: account.recoveryKey, newPassword: NEW_PASSWORD, argon2id: fastArgon2 })
    stillOld.cancel()

    await prepared.commit()
    await expect(
      prepareRecovery({ api: probe.api, email: account.email, recoveryKey: account.recoveryKey, newPassword: NEW_PASSWORD, argon2id: fastArgon2 })
    ).rejects.toThrow()
    const withNew = await prepareRecovery({ api: probe.api, email: account.email, recoveryKey: prepared.recoveryKey, newPassword: NEW_PASSWORD, argon2id: fastArgon2 })
    withNew.cancel()
  })

  it('recovery sets a new password and a new recovery key, and accepts a formatted key', async () => {
    const account = await freshAccount()
    const device = createDevice(server.base)
    const formatted = ` ${account.recoveryKey.match(/.{1,4}/g).join(' ')}\n`
    const prepared = await prepareRecovery({
      api: device.api,
      email: account.email,
      recoveryKey: formatted,
      newPassword: NEW_PASSWORD,
      argon2id: fastArgon2,
    })
    const { vault } = await prepared.commit()
    expect(vault.currentKeyId).toBe(account.vault.currentKeyId)
    expect((await login(account.email, NEW_PASSWORD)).vault.currentKeyId).toBe(account.vault.currentKeyId)
    // The old session was signed out.
    await expect(account.device.api.get('/api/notes')).rejects.toMatchObject({ status: 401 })
  })

  it('account deletion requires the password (SEC-6)', async () => {
    const account = await freshAccount()
    await expect(
      deleteAccount({ api: account.device.api, bootstrap: account.data.vaultBootstrap, password: 'wrong password!!', argon2id: fastArgon2 })
    ).rejects.toThrow()
    await deleteAccount({ api: account.device.api, bootstrap: account.data.vaultBootstrap, password: PASSWORD, argon2id: fastArgon2 })
    expect((await server.pool.query('SELECT 1 FROM users WHERE id = $1', [account.data.user.id])).rows).toHaveLength(0)
  })
})

describe('legacy account upgrade (DATA-5, CRYPTO-2, CRYPTO-3)', () => {
  it('migrates every note, re-encrypts images and linked attachments, and tolerates missing files', async () => {
    const legacy = await insertLegacyUser(server.pool, { password: 'old-weak-pw' })
    const image = `imported-u${legacy.user.id}-aaaaaaaaaaaa-photo.png`
    const pdf = `imported-u${legacy.user.id}-bbbbbbbbbbbb-tax.pdf`
    await fsp.mkdir(server.config.storage.legacyUploadsDir, { recursive: true })
    await fsp.writeFile(path.join(server.config.storage.legacyUploadsDir, image), 'PNG BYTES')
    await fsp.writeFile(path.join(server.config.storage.legacyUploadsDir, pdf), 'PDF BYTES')
    for (const filename of [image, pdf]) {
      await server.pool.query("INSERT INTO legacy_uploads (filename, user_id, source) VALUES ($1, $2, 'test')", [
        filename,
        legacy.user.id,
      ])
    }
    const active = await insertLegacyNote(server.pool, legacy.user.id, {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Taxes 2025' }] },
        { type: 'image', attrs: { src: `/api/uploads/${image}` } },
        { type: 'paragraph', content: [{ type: 'text', text: 'return', marks: [{ type: 'link', attrs: { href: `/api/uploads/${pdf}` } }] }] },
        { type: 'image', attrs: { src: '/api/uploads/gone.jpg' } },
        { type: 'image', attrs: { src: '/api/uploads/100%.jpg' } },
      ],
    })
    const trashed = await insertLegacyNote(
      server.pool,
      legacy.user.id,
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'in the trash' }] }] },
      { deleted: true }
    )

    const device = createDevice(server.base)
    const loginResponse = await device.api.post('/api/auth/login', { email: legacy.email, password: legacy.password })
    expect(loginResponse.migrationRequired).toBe(true)

    let acknowledged = null
    const result = await migrateLegacyAccount({
      api: device.api,
      newPassword: NEW_PASSWORD,
      acknowledgeRecoveryKey: async (key) => {
        // Nothing is committed before the user confirms the recovery key.
        expect((await server.pool.query('SELECT auth_mode FROM users WHERE id = $1', [legacy.user.id])).rows[0].auth_mode).toBe('legacy')
        acknowledged = key
      },
      argon2id: fastArgon2,
    })
    expect(acknowledged).toBe(result.recoveryKey)
    expect(result.summary).toMatchObject({ notes: 2, trashedNotes: 1, filesMigrated: 2 })
    expect(result.summary.missingFiles).toContain('gone.jpg')

    const rows = (await server.pool.query('SELECT * FROM notes WHERE user_id = $1 ORDER BY id', [legacy.user.id])).rows
    expect(rows.every((row) => row.content === null && row.encrypted_content)).toBe(true)
    expect(rows.find((row) => row.id === trashed.id).deleted_at).not.toBeNull()

    const content = await result.vault.decryptJson(rows.find((r) => r.id === active.id).encrypted_content, CONTEXTS.noteContent(active.id))
    const refs = [...collectBlobReferences(content).values()]
    expect(refs).toHaveLength(2)
    const link = content.content[2].content[0].marks[0]
    const attachment = parseAttachmentHref(link.attrs.href)
    expect(attachment.name).toBe(pdf)
    const bytes = await fetchAttachmentBytes({ api: device.api, vault: result.vault, reference: attachment })
    expect(new TextDecoder().decode(bytes)).toBe('PDF BYTES')
    expect(content.content[3].content[0].text).toBe('[Image unavailable: gone.jpg]')
    expect(content.content[4].content[0].text).toMatch(/Image unavailable/)

    // Plaintext originals left the served directory.
    const remaining = await fsp.readdir(server.config.storage.legacyUploadsDir)
    expect(remaining).not.toContain(image)
    expect(remaining).not.toContain(pdf)

    // CRYPTO-2: the old password is gone; the new one unlocks the vault.
    expect((await login(legacy.email, NEW_PASSWORD)).vault.currentKeyId).toBe(result.vault.currentKeyId)
  })

  it('refuses a weak new password before touching anything', async () => {
    const legacy = await insertLegacyUser(server.pool)
    const device = createDevice(server.base)
    await device.api.post('/api/auth/login', { email: legacy.email, password: legacy.password })
    await expect(
      migrateLegacyAccount({ api: device.api, newPassword: 'short', acknowledgeRecoveryKey: async () => {}, argon2id: fastArgon2 })
    ).rejects.toThrow(/at least 12/)
  })

  it('aborting at the recovery-key step commits nothing', async () => {
    const legacy = await insertLegacyUser(server.pool)
    await insertLegacyNote(server.pool, legacy.user.id, { type: 'doc' })
    const device = createDevice(server.base)
    await device.api.post('/api/auth/login', { email: legacy.email, password: legacy.password })
    await expect(
      migrateLegacyAccount({
        api: device.api,
        newPassword: NEW_PASSWORD,
        acknowledgeRecoveryKey: async () => {
          throw new Error('user cancelled')
        },
        argon2id: fastArgon2,
      })
    ).rejects.toThrow('user cancelled')
    const user = (await server.pool.query('SELECT auth_mode FROM users WHERE id = $1', [legacy.user.id])).rows[0]
    expect(user.auth_mode).toBe('legacy')
    // The legacy session still works: the user stays signed in (DATA-5).
    expect((await device.api.get('/api/notes')).notes).toHaveLength(1)
  })
})
