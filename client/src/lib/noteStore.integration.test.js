import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDevice, fastArgon2, startServer } from '../test/serverHarness.js'
import { loginEncrypted, prelogin, reauthenticate, signup } from './account.js'
import { uploadAttachment } from './attachments.js'
import { CONTEXTS } from './envelope.js'
import { createE2EECodec } from './noteCodecs.js'
import { createNoteStore } from './noteStore.js'
import { imageAttrsForBlob } from './noteContent.js'
import * as cache from './persistentNoteCache.js'

const PASSWORD = 'correct horse battery staple'
let server

beforeAll(async () => {
  server = await startServer()
})

afterAll(async () => {
  await server.stop()
})

function doc(text, extra = []) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...extra] }
}

function textOf(content) {
  return content.content[0].content?.[0]?.text
}

let counter = 0
async function newAccount() {
  counter += 1
  const device = createDevice(server.base)
  const email = `store-${Date.now()}-${counter}@example.com`
  const { data, vault } = await signup({
    api: device.api,
    email,
    password: PASSWORD,
    firstName: 'A',
    lastName: 'B',
    argon2id: fastArgon2,
  })
  return { device, email, vault, userId: data.user.id }
}

async function secondDevice(email) {
  const device = createDevice(server.base)
  const { vault, data } = await loginEncrypted({
    api: device.api,
    email,
    password: PASSWORD,
    preloginData: await prelogin(device.api, email),
    argon2id: fastArgon2,
  })
  return { device, vault, userId: data.user.id }
}

function makeStore({ device, vault, userId }) {
  return createNoteStore({ api: device.api, codec: createE2EECodec(vault), userId, log: { warn() {}, error() {} } })
}

async function settle(store, id) {
  for (let i = 0; i < 200; i += 1) {
    const state = store.getSnapshot().saveStates[id]?.state
    if (!state || ['conflict', 'failed', 'offline', 'auth', 'retrying'].includes(state)) {
      return state || 'saved'
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`save for note ${id} did not settle`)
}

async function serverPlaintext(vault, noteId) {
  const row = (await server.pool.query('SELECT * FROM notes WHERE id = $1', [noteId])).rows[0]
  return vault.decryptJson(row.encrypted_content, CONTEXTS.noteContent(noteId))
}

beforeEach(() => {
  counter += 1
})

describe('saving (DATA-2)', () => {
  it('creates and saves notes with revisions and reports their blob references', async () => {
    const account = await newAccount()
    const store = makeStore(account)
    await store.start()

    const image = await uploadAttachment({
      api: account.device.api,
      vault: account.vault,
      bytes: new TextEncoder().encode('png'),
      mimeType: 'image/png',
    })
    const note = await store.createNote()
    expect(await settle(store, note.id)).toBe('saved')
    store.updateNote(note.id, doc('with image', [{ type: 'image', attrs: imageAttrsForBlob(image) }]))
    expect(await settle(store, note.id)).toBe('saved')

    expect(textOf(await serverPlaintext(account.vault, note.id))).toBe('with image')
    const refs = await server.pool.query('SELECT blob_id FROM blob_refs WHERE note_id = $1', [note.id])
    expect(refs.rows.map((r) => r.blob_id)).toEqual([Number(image.blobId)])
    expect(store.getSnapshot().notes[0].summary.title).toBe('with image')
    expect(store.hasUnsavedChanges()).toBe(false)
    store.stop()
  })

  it('keeps edits made offline in the encrypted outbox and sends them after a reload', async () => {
    const account = await newAccount()
    const store = makeStore(account)
    await store.start()
    const note = await store.createNote()
    await settle(store, note.id)

    account.device.setOffline(true)
    store.updateNote(note.id, doc('written offline'))
    expect(await settle(store, note.id)).toBe('offline')
    expect(store.hasUnsavedChanges()).toBe(true)

    // Only ciphertext is persisted locally.
    const entries = await cache.getOutboxEntries(account.userId)
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries[0])).not.toContain('written offline')
    store.stop()

    // "Reload": a fresh store on the same device, back online.
    account.device.setOffline(false)
    const reloaded = makeStore(account)
    await reloaded.start()
    expect(await settle(reloaded, note.id)).toBe('saved')
    expect(textOf(await serverPlaintext(account.vault, note.id))).toBe('written offline')
    expect(await cache.getOutboxEntries(account.userId)).toHaveLength(0)
    reloaded.stop()
  })

  it('pauses on an expired session and resumes after signing in again, without losing the edit', async () => {
    const account = await newAccount()
    const store = makeStore(account)
    await store.start()
    const note = await store.createNote()
    await settle(store, note.id)

    // Another device signs everyone else out.
    const other = await secondDevice(account.email)
    await other.device.api.post('/api/auth/sessions/revoke-others')

    store.updateNote(note.id, doc('typed after expiry'))
    expect(await settle(store, note.id)).toBe('auth')
    expect(store.getSnapshot().sessionExpired).toBe(true)

    await reauthenticate({ api: account.device.api, email: account.email, password: PASSWORD, argon2id: fastArgon2 })
    store.resumeAfterAuth()
    expect(await settle(store, note.id)).toBe('saved')
    expect(textOf(await serverPlaintext(account.vault, note.id))).toBe('typed after expiry')
    store.stop()
  })
})

describe('concurrent devices (DATA-3)', () => {
  async function conflictSetup() {
    const laptop = await newAccount()
    const laptopStore = makeStore(laptop)
    await laptopStore.start()
    const note = await laptopStore.createNote({ content: doc('Shopping list') })
    await settle(laptopStore, note.id)
    await laptopStore.openNote(note.id)

    const phone = await secondDevice(laptop.email)
    const phoneStore = makeStore(phone)
    await phoneStore.start()
    await phoneStore.openNote(note.id)
    phoneStore.updateNote(note.id, doc('Shopping list - milk, eggs, PHONE EDIT'))
    expect(await settle(phoneStore, note.id)).toBe('saved')

    laptopStore.updateNote(note.id, doc('Shopping list!'))
    expect(await settle(laptopStore, note.id)).toBe('conflict')
    return { laptop, laptopStore, phone, phoneStore, note }
  }

  it('never overwrites the newer version; "theirs" keeps the local edit in history', async () => {
    const { laptop, laptopStore, phoneStore, note } = await conflictSetup()
    expect(textOf(await serverPlaintext(laptop.vault, note.id))).toBe('Shopping list - milk, eggs, PHONE EDIT')
    expect(laptopStore.getSnapshot().saveStates[note.id].conflict.code).toBe('REVISION_CONFLICT')

    await laptopStore.resolveConflict(note.id, 'theirs')
    const opened = await laptopStore.openNote(note.id)
    expect(textOf(opened.content)).toBe('Shopping list - milk, eggs, PHONE EDIT')
    const history = await laptopStore.listRevisions(note.id)
    const conflict = history.find((rev) => rev.kind === 'conflict')
    expect(textOf((await laptopStore.loadRevision(note.id, conflict.id)).content)).toBe('Shopping list!')
    laptopStore.stop()
    phoneStore.stop()
  })

  it('"mine" saves the local version on top, keeping the other one in history', async () => {
    const { laptop, laptopStore, phoneStore, note } = await conflictSetup()
    await laptopStore.resolveConflict(note.id, 'mine')
    expect(await settle(laptopStore, note.id)).toBe('saved')
    expect(textOf(await serverPlaintext(laptop.vault, note.id))).toBe('Shopping list!')
    const snapshots = (await laptopStore.listRevisions(note.id)).filter((rev) => rev.kind === 'snapshot')
    const texts = await Promise.all(snapshots.map(async (s) => textOf((await laptopStore.loadRevision(note.id, s.id)).content)))
    expect(texts).toContain('Shopping list - milk, eggs, PHONE EDIT')
    laptopStore.stop()
    phoneStore.stop()
  })

  it('"copy" keeps both versions as separate notes', async () => {
    const { laptop, laptopStore, phoneStore, note } = await conflictSetup()
    const copy = await laptopStore.resolveConflict(note.id, 'copy')
    expect(await settle(laptopStore, copy.id)).toBe('saved')
    expect(textOf(await serverPlaintext(laptop.vault, copy.id))).toBe('Shopping list!')
    expect(textOf(await serverPlaintext(laptop.vault, note.id))).toBe('Shopping list - milk, eggs, PHONE EDIT')
    laptopStore.stop()
    phoneStore.stop()
  })

  it('picks up remote edits on sync and reloads an open note without local changes', async () => {
    const laptop = await newAccount()
    const laptopStore = makeStore(laptop)
    await laptopStore.start()
    const note = await laptopStore.createNote({ content: doc('v1') })
    await settle(laptopStore, note.id)

    const phone = await secondDevice(laptop.email)
    const phoneStore = makeStore(phone)
    await phoneStore.start()
    await phoneStore.openNote(note.id)
    const events = []
    phoneStore.onEvent((event) => events.push(event))

    await laptopStore.openNote(note.id)
    laptopStore.updateNote(note.id, doc('v2 from laptop'))
    await settle(laptopStore, note.id)

    await phoneStore.sync()
    expect(events).toContainEqual(expect.objectContaining({ type: 'note-replaced', id: note.id }))
    expect(textOf((await phoneStore.openNote(note.id)).content)).toBe('v2 from laptop')
    laptopStore.stop()
    phoneStore.stop()
  })

  it('a note trashed elsewhere turns a save into a decision, not a silent loss', async () => {
    const laptop = await newAccount()
    const laptopStore = makeStore(laptop)
    await laptopStore.start()
    const note = await laptopStore.createNote({ content: doc('keep me') })
    await settle(laptopStore, note.id)
    const phone = await secondDevice(laptop.email)
    await phone.device.api.put(`/api/notes/${note.id}/trash`)

    laptopStore.updateNote(note.id, doc('edited after trash'))
    expect(await settle(laptopStore, note.id)).toBe('conflict')
    expect(laptopStore.getSnapshot().saveStates[note.id].conflict.code).toBe('NOTE_TRASHED')
    await laptopStore.resolveConflict(note.id, 'mine')
    expect(await settle(laptopStore, note.id)).toBe('saved')
    const row = (await server.pool.query('SELECT deleted_at FROM notes WHERE id = $1', [note.id])).rows[0]
    expect(row.deleted_at).toBeNull()
    expect(textOf(await serverPlaintext(laptop.vault, note.id))).toBe('edited after trash')
    laptopStore.stop()
  })
})

describe('resilience', () => {
  async function corruptedFreshStore(fields) {
    const account = await newAccount()
    const store = makeStore(account)
    await store.start()
    const good = await store.createNote({ content: doc('good note') })
    const bad = await store.createNote({ content: doc('bad note') })
    await settle(store, good.id)
    await settle(store, bad.id)
    store.stop()

    for (const field of fields) {
      const row = (await server.pool.query(`SELECT ${field} AS envelope FROM notes WHERE id = $1`, [bad.id])).rows[0]
      const flipped = `${row.envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${row.envelope.ciphertext.slice(1)}`
      await server.pool.query(`UPDATE notes SET ${field} = $2 WHERE id = $1`, [
        bad.id,
        JSON.stringify({ ...row.envelope, ciphertext: flipped }),
      ])
    }

    const fresh = await secondDevice(account.email)
    const freshStore = createNoteStore({
      api: fresh.device.api,
      codec: createE2EECodec(fresh.vault),
      userId: account.userId + 100000,
      log: { warn() {}, error() {} },
    })
    await freshStore.start()
    return { account, freshStore, good, bad }
  }

  it('DATA-8: an undecryptable note is flagged and does not hide the others', async () => {
    const { freshStore, good, bad } = await corruptedFreshStore(['encrypted_summary', 'encrypted_content'])
    const before = (await server.pool.query('SELECT * FROM notes WHERE id = $1', [bad.id])).rows[0]
    const { notes, status } = freshStore.getSnapshot()
    expect(status).toBe('ready')
    expect(notes).toHaveLength(2)
    expect(notes.find((n) => n.id === good.id).summary.title).toBe('good note')
    // Listed as unreadable, not as an ordinary "Untitled" note.
    expect(notes.find((n) => n.id === bad.id)).toMatchObject({ decryptError: { code: 'DECRYPT_FAILED' }, summary: { title: '' } })

    // Opening it reports why; background indexing flags it in the list.
    await expect(freshStore.openNote(bad.id)).rejects.toMatchObject({ diagnostic: { code: 'DECRYPT_FAILED' } })
    await vi.waitFor(() => expect(freshStore.getSnapshot().notes.find((n) => n.id === bad.id).decryptError?.code).toBe('DECRYPT_FAILED'))
    // Nothing was written over the damaged record.
    const after = (await server.pool.query('SELECT * FROM notes WHERE id = $1', [bad.id])).rows[0]
    expect(after.encrypted_content).toEqual(before.encrypted_content)
    expect(after.revision).toBe(before.revision)
    freshStore.stop()
  })

  it('DATA-8: an unreadable summary is flagged, then rebuilt from the readable content', async () => {
    const { account, freshStore, bad } = await corruptedFreshStore(['encrypted_summary'])
    const listed = freshStore.getSnapshot().notes.find((n) => n.id === bad.id)
    await vi.waitFor(() => {
      const record = freshStore.getSnapshot().notes.find((n) => n.id === bad.id)
      expect(record.decryptError).toBeNull()
      expect(record.summary.title).toBe('bad note')
    })
    const row = (await server.pool.query('SELECT * FROM notes WHERE id = $1', [bad.id])).rows[0]
    expect(await account.vault.decryptJson(row.encrypted_summary, CONTEXTS.noteSummary(bad.id))).toMatchObject({ title: 'bad note' })
    expect(row.revision).toBe(listed.revision)
    freshStore.stop()
  })

  it('encrypts plaintext residue left in an encrypted account (DATA-6/DATA-7 victims)', async () => {
    const account = await newAccount()
    const store = makeStore(account)
    await store.start()
    const note = await store.createNote({ content: doc('x') })
    await settle(store, note.id)
    store.stop()

    // A 1.x importer wrote plaintext into this encrypted account.
    await server.pool.query('ALTER TABLE notes DISABLE TRIGGER notes_before_write')
    await server.pool.query('UPDATE notes SET encrypted_content = NULL, content = $2 WHERE id = $1', [
      note.id,
      JSON.stringify(doc('imported plaintext')),
    ])
    await server.pool.query('ALTER TABLE notes ENABLE TRIGGER notes_before_write')

    const again = makeStore(account)
    await again.start()
    const opened = await again.openNote(note.id)
    expect(textOf(opened.content)).toBe('imported plaintext')
    expect(await settle(again, note.id)).toBe('saved')
    const row = (await server.pool.query('SELECT content, encrypted_content FROM notes WHERE id = $1', [note.id])).rows[0]
    expect(row.content).toBeNull()
    expect(textOf(await account.vault.decryptJson(row.encrypted_content, CONTEXTS.noteContent(note.id)))).toBe(
      'imported plaintext'
    )
    again.stop()
  })

  it('CRYPTO-5: detects a server rolling a note back to an older revision', async () => {
    const account = await newAccount()
    const store = makeStore(account)
    await store.start()
    const note = await store.createNote({ content: doc('r1') })
    await settle(store, note.id)
    store.updateNote(note.id, doc('r2'))
    await settle(store, note.id)
    store.updateNote(note.id, doc('r3'))
    await settle(store, note.id)
    store.stop()
    await new Promise((resolve) => setTimeout(resolve, 1100)) // high-water marks persist

    await server.pool.query('UPDATE notes SET revision = 1 WHERE id = $1', [note.id])
    const again = makeStore(account)
    const events = []
    again.onEvent((event) => events.push(event))
    await again.start()
    expect(events).toContainEqual(expect.objectContaining({ type: 'rollback', id: note.id }))
    again.stop()
  })

  it('reconciles blob references for notes saved before tracking (enables GC safely)', async () => {
    const account = await newAccount()
    const store = makeStore(account)
    await store.start()
    const image = await uploadAttachment({ api: account.device.api, vault: account.vault, bytes: new Uint8Array([1, 2, 3]) })
    const note = await store.createNote({ content: doc('img', [{ type: 'image', attrs: imageAttrsForBlob(image) }]) })
    await settle(store, note.id)
    store.stop()

    // Pretend the note predates reference tracking.
    await server.pool.query('UPDATE notes SET blob_refs_known = FALSE WHERE id = $1', [note.id])
    await server.pool.query('DELETE FROM blob_refs WHERE note_id = $1', [note.id])
    await server.pool.query('UPDATE users SET profile_ref_known = FALSE WHERE id = $1', [account.userId])
    await cache.clearUserData(account.userId)
    const profileIv = (await server.pool.query('SELECT encrypted_profile FROM users WHERE id = $1', [account.userId])).rows[0]
      .encrypted_profile.iv

    const again = createNoteStore({
      api: account.device.api,
      codec: createE2EECodec(account.vault),
      userId: account.userId,
      getProfileReference: () => ({ blobId: null, profileIv }),
    })
    await again.start()
    for (let i = 0; i < 200 && !again.getSnapshot().refs.checked; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(again.getSnapshot().refs).toEqual({ checked: true, enabled: true })
    const refs = await server.pool.query('SELECT blob_id FROM blob_refs WHERE note_id = $1', [note.id])
    expect(refs.rows.map((r) => r.blob_id)).toEqual([Number(image.blobId)])
    again.stop()
  })

  it('trash, restore and permanent delete', async () => {
    const account = await newAccount()
    const store = makeStore(account)
    await store.start()
    const note = await store.createNote({ content: doc('cycle') })
    await settle(store, note.id)
    await store.trashNote(note.id)
    expect(store.getSnapshot().trash.map((n) => n.id)).toContain(note.id)
    await store.restoreNote(note.id)
    expect(store.getSnapshot().notes.map((n) => n.id)).toContain(note.id)
    await store.trashNote(note.id)
    await store.deleteNotePermanently(note.id)
    expect(store.getSnapshot().trash.map((n) => n.id)).not.toContain(note.id)
    store.stop()
  })
})
