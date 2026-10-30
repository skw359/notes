import { ApiError } from './api.js'
import { uploadAttachment } from './attachments.js'
import { encodeBase64Url } from './base64.js'
import { CONTEXTS } from './envelope.js'
import { blobIdsForSave, createNoteSummary, extractLegacyReferences, migrateLegacyContent } from './noteContent.js'

const BATCH = 100

async function listAllNoteIds(api) {
  const ids = []
  for (const path of ['/api/notes', '/api/notes/trash']) {
    let cursor = null
    do {
      const page = await api.get(`${path}?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      ids.push(...page.notes.map((note) => note.id))
      cursor = page.nextCursor
    } while (cursor)
  }
  return ids
}

async function decryptNote(vault, note) {
  if (note.encrypted_content) {
    return vault.decryptJson(note.encrypted_content, CONTEXTS.noteContent(note.id))
  }
  return note.content || null
}

/**
 * CRYPTO-3, for accounts that were upgraded by 1.x: its migration only
 * handled images, so links to other uploaded files (PDFs, audio, video)
 * still point at plaintext files the app can no longer serve. This finds
 * them in the decrypted notes (the server cannot read notes).
 */
export async function scanLegacyAttachments({ api, vault, onProgress = () => {} }) {
  const { files } = await api.get('/api/legacy-uploads')
  if (!files.length) {
    return { files: [], notes: [], unavailable: [] }
  }
  const owned = new Set(files.map((file) => file.filename))
  const ids = await listAllNoteIds(api)
  const notes = []
  const unavailable = new Set()

  for (let i = 0; i < ids.length; i += BATCH) {
    const { notes: batch } = await api.post('/api/notes/batch', { ids: ids.slice(i, i + BATCH) })
    for (const note of batch) {
      let content
      try {
        content = await decryptNote(vault, note)
      } catch {
        continue
      }
      const referenced = [...extractLegacyReferences(content)]
      if (!referenced.length) {
        continue
      }
      for (const filename of referenced) {
        if (!owned.has(filename)) {
          unavailable.add(filename)
        }
      }
      const rescuable = referenced.filter((filename) => owned.has(filename))
      if (rescuable.length) {
        notes.push({ id: note.id, filenames: rescuable })
      }
    }
    onProgress({ phase: 'scan', done: Math.min(i + BATCH, ids.length), total: ids.length })
  }

  const needed = new Set(notes.flatMap((note) => note.filenames))
  return { files: files.filter((file) => needed.has(file.filename)), notes, unavailable: [...unavailable] }
}

/**
 * Re-encrypts every referenced legacy file into an attachment and rewrites
 * the notes that link to it. A file is only released for deletion on the
 * server (quarantine) once every note referencing it has been saved.
 */
export async function rescueLegacyAttachments({ api, vault, scan, onProgress = () => {} }) {
  const plan = scan || (await scanLegacyAttachments({ api, vault, onProgress }))
  const uploaded = new Map()
  const byHash = new Map()
  const owned = new Set(plan.files.map((file) => file.filename))

  async function resolveFile(filename) {
    if (!owned.has(filename)) {
      return null
    }
    if (uploaded.has(filename)) {
      return uploaded.get(filename)
    }
    const response = await api.request(`/api/legacy-uploads/${encodeURIComponent(filename)}`, { raw: true })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const hash = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    let reference = byHash.get(hash)
    if (!reference) {
      reference = await uploadAttachment({
        api,
        vault,
        bytes,
        mimeType: response.headers.get('x-legacy-mime-type') || 'application/octet-stream',
        name: filename,
      })
      byHash.set(hash, reference)
    }
    const named = { ...reference, name: filename }
    uploaded.set(filename, named)
    return named
  }

  const savedNotes = new Set()
  let done = 0
  for (const target of plan.notes) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { note } = await api.get(`/api/notes/${target.id}`)
      const content = await decryptNote(vault, note)
      // Files that are not ours stay untouched (the link is left as is).
      const rewritten = await migrateLegacyContent(content, resolveFile, { keepUnresolved: true })
      try {
        await api.put(`/api/notes/${note.id}`, {
          baseRevision: note.revision,
          encryptedContent: await vault.encryptJson(rewritten, CONTEXTS.noteContent(note.id), {
            revision: note.revision + 1,
          }),
          encryptedSummary: await vault.encryptJson(createNoteSummary(rewritten), CONTEXTS.noteSummary(note.id)),
          blobIds: blobIdsForSave(rewritten),
        })
        savedNotes.add(note.id)
        break
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || attempt === 2) {
          throw error
        }
      }
    }
    done += 1
    onProgress({ phase: 'notes', done, total: plan.notes.length })
  }

  // Release each plaintext file once all of its notes were rewritten.
  const released = []
  for (const [filename, reference] of uploaded) {
    const referencingNotes = plan.notes.filter((note) => note.filenames.includes(filename))
    if (referencingNotes.every((note) => savedNotes.has(note.id))) {
      await api.post(`/api/legacy-uploads/${encodeURIComponent(filename)}/migrated`, { blobId: Number(reference.blobId) })
      released.push(filename)
    }
  }
  return { notesUpdated: savedNotes.size, filesRescued: released.length, released }
}
