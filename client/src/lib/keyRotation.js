import { ApiError } from './api.js'
import { fetchAttachmentBytes, uploadAttachment } from './attachments.js'
import { decryptProfile, encryptProfile, assertPasswordStrength } from './account.js'
import {
  CONTEXTS,
  createPasswordWrapping,
  createRecoveryWrapping,
  derivePasswordMaterial,
  keyFingerprint,
  randomBytes,
  unwrapVaultKey,
  wrapVaultKey,
  decryptEnvelope,
} from './envelope.js'
import { argon2id as defaultArgon2id } from './kdf.js'
import { blobIdsForSave, collectBlobReferences, createNoteSummary, rewriteBlobReferences } from './noteContent.js'
import { Vault } from './vault.js'

const BATCH = 100

async function allPending(api, type) {
  const items = []
  let after = 0
  for (;;) {
    const page = await api.get(`/api/vault/pending?type=${type}&limit=500&after=${after}`)
    items.push(...page.items)
    if (!page.next) {
      return items
    }
    after = page.next
  }
}

async function allNotes(api, path) {
  const notes = []
  let cursor = null
  do {
    const page = await api.get(`${path}?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    notes.push(...page.notes)
    cursor = page.nextCursor
  } while (cursor)
  return notes
}

/**
 * CRYPTO-1, step 1: prepare a new vault key. Returns the new recovery key for
 * the user to save; `commit()` (after they confirm) atomically makes the new
 * key current on the server, wrapped by the new password and the new
 * recovery key, with every previous key wrapped under it so not yet
 * re-encrypted data stays readable. Other devices are signed out.
 */
export async function prepareKeyRotation({ api, bootstrap, currentPassword, newPassword, argon2id = defaultArgon2id }) {
  assertPasswordStrength(newPassword)
  const current = await derivePasswordMaterial(currentPassword, bootstrap.salt, bootstrap.kdfParams, { argon2id })
  let currentRaw
  try {
    currentRaw = await unwrapVaultKey(current.kek, bootstrap.wrappedVaultKey, CONTEXTS.vaultKeyPassword)
  } catch {
    throw new Error('Your current password is incorrect')
  }

  const currentKeyId = await keyFingerprint(currentRaw)
  if (bootstrap.vaultKeyId && bootstrap.vaultKeyId !== currentKeyId) {
    currentRaw.fill(0)
    throw new Error('The vault key does not match this account')
  }

  // Older keys still in the keyring (an unfinished earlier rotation).
  const currentKey = await crypto.subtle.importKey('raw', currentRaw, { name: 'AES-GCM' }, false, ['decrypt'])
  const previousRaw = new Map()
  for (const [keyId, envelope] of Object.entries(bootstrap.keyring || {})) {
    previousRaw.set(keyId, await decryptEnvelope(currentKey, envelope, { context: CONTEXTS.keyring(keyId) }))
  }

  const newRaw = randomBytes(32)
  const newKeyId = await keyFingerprint(newRaw)
  const newWrappingKey = await crypto.subtle.importKey('raw', newRaw, { name: 'AES-GCM' }, false, ['encrypt'])

  const keyring = { [currentKeyId]: await wrapVaultKey(newWrappingKey, currentRaw, CONTEXTS.keyring(currentKeyId), newKeyId) }
  const keyringRaw = { [currentKeyId]: currentRaw }
  for (const [keyId, raw] of previousRaw) {
    keyring[keyId] = await wrapVaultKey(newWrappingKey, raw, CONTEXTS.keyring(keyId), newKeyId)
    keyringRaw[keyId] = raw
  }

  const passwordWrapping = await createPasswordWrapping(newPassword, newRaw, newKeyId, { argon2id })
  const recovery = await createRecoveryWrapping(newRaw, newKeyId)

  function wipe() {
    newRaw.fill(0)
    for (const raw of Object.values(keyringRaw)) {
      raw.fill(0)
    }
  }

  return {
    recoveryKey: recovery.recoveryKey,
    newKeyId,
    async commit() {
      try {
        const data = await api.post('/api/vault/rotation/start', {
          currentAuthSecret: current.authSecret,
          newKeyId,
          ...passwordWrapping,
          recoveryVerifier: recovery.recoveryVerifier,
          wrappedVaultKeyRecovery: recovery.wrappedVaultKeyRecovery,
          keyring,
        })
        const vault = await Vault.open(newRaw.slice(), {
          keyring: data.vaultBootstrap.keyring,
          minEnvelopeVersion: data.vaultBootstrap.minEnvelopeVersion,
        })
        return { data, vault }
      } finally {
        wipe()
      }
    },
    cancel: wipe,
  }
}

/**
 * Step 2 (and the CRYPTO-5 format upgrade, which is the same job with the
 * current key): re-encrypts every note, revision, attachment and the
 * profile that is not yet a v3 envelope under the current key. Resumable:
 * the server reports what is still pending, so an interrupted run just
 * continues. Attachments get new UUIDs and blob ids; old blobs become
 * unreferenced and are garbage-collected later.
 */
export async function reencryptVault({ api, vault, onProgress = () => {}, signal }) {
  const mapping = new Map()

  async function reencryptBlob(reference) {
    const key = String(reference.blobId)
    if (mapping.has(key)) {
      return mapping.get(key)
    }
    const bytes = await fetchAttachmentBytes({ api, vault, reference })
    const uploaded = await uploadAttachment({
      api,
      vault,
      bytes,
      mimeType: reference.mimeType,
      name: reference.name,
      replaces: reference.blobId,
    })
    mapping.set(key, uploaded)
    return uploaded
  }

  // Decided from the reference inside the encrypted note/profile, not from
  // the server's pending list: the server may not know yet that an old
  // note or profile references a blob.
  function needsBlobUpgrade(reference) {
    return !(Number(reference.blobVersion) === 3 && reference.blobUuid && reference.keyId === vault.currentKeyId)
  }

  async function rewriteContent(content) {
    const replacements = new Map()
    for (const reference of collectBlobReferences(content).values()) {
      if (needsBlobUpgrade(reference)) {
        replacements.set(String(reference.blobId), await reencryptBlob(reference))
      }
    }
    return replacements.size ? rewriteBlobReferences(content, replacements) : content
  }

  const status = await api.get('/api/vault/status')

  // Notes: anything not yet v3 under the current key, plus any note that
  // references a pending attachment. Notes that need no rewrite still get
  // their attachment references reported (completion requires them).
  const ids = [...(await allNotes(api, '/api/notes')), ...(await allNotes(api, '/api/notes/trash'))].map((note) => note.id)
  const unknownRefs = new Map((await api.get('/api/blobs/refs/unknown')).notes.map((entry) => [entry.id, entry.revision]))
  const reconcile = []
  const total = ids.length
  let done = 0

  for (let i = 0; i < ids.length; i += BATCH) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    const { notes } = await api.post('/api/notes/batch', { ids: ids.slice(i, i + BATCH) })
    for (const note of notes) {
      let content = null
      if (note.encrypted_content) {
        content = await vault.decryptJson(note.encrypted_content, CONTEXTS.noteContent(note.id))
      } else if (note.content) {
        content = note.content
      }
      const references = content ? collectBlobReferences(content) : new Map()
      const needsRewrite =
        vault.needsUpgrade(note.encrypted_content) ||
        vault.needsUpgrade(note.encrypted_summary) ||
        (!note.encrypted_content && note.content) ||
        [...references.values()].some(needsBlobUpgrade)
      if (needsRewrite) {
        await saveReencrypted(note, content)
      } else if (unknownRefs.get(note.id) === note.revision) {
        reconcile.push({ id: note.id, revision: note.revision, blobIds: content ? blobIdsForSave(content) : [] })
      }
      done += 1
      onProgress({ phase: 'notes', done, total })
    }
  }
  for (let i = 0; i < reconcile.length; i += 500) {
    await api.post('/api/blobs/refs/reconcile', { notes: reconcile.slice(i, i + 500) })
  }

  async function saveReencrypted(note, content) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rewritten = content ? await rewriteContent(content) : null
      const summary = rewritten ? createNoteSummary(rewritten) : await vault.decryptJson(note.encrypted_summary, CONTEXTS.noteSummary(note.id))
      try {
        if (rewritten) {
          await api.put(`/api/notes/${note.id}`, {
            baseRevision: note.revision,
            encryptedContent: await vault.encryptJson(rewritten, CONTEXTS.noteContent(note.id), { revision: note.revision + 1 }),
            encryptedSummary: await vault.encryptJson(summary, CONTEXTS.noteSummary(note.id)),
            blobIds: blobIdsForSave(rewritten),
            reason: 'reencrypt',
          })
        } else if (note.encrypted_summary) {
          await api.patch(`/api/notes/${note.id}/summary`, {
            encryptedSummary: await vault.encryptJson(summary, CONTEXTS.noteSummary(note.id)),
          })
        }
        return
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || !error.data?.note) {
          throw error
        }
        // Edited elsewhere meanwhile: re-read and try again.
        note = error.data.note
        content = note.encrypted_content ? await vault.decryptJson(note.encrypted_content, CONTEXTS.noteContent(note.id)) : null
      }
    }
    throw new Error(`Note ${note.id} kept changing during re-encryption; run the upgrade again`)
  }

  // History (snapshots and conflicts).
  const revisions = await allPending(api, 'revisions')
  let revisionsDone = 0
  for (const item of revisions) {
    const { revision } = await api.get(`/api/notes/${item.note_id}/revisions/${item.id}`)
    const content = await vault.decryptJson(revision.encrypted_content, CONTEXTS.noteContent(item.note_id))
    const rewritten = await rewriteContent(content)
    const summary = revision.encrypted_summary
      ? await vault.decryptJson(revision.encrypted_summary, CONTEXTS.noteSummary(item.note_id))
      : createNoteSummary(rewritten)
    await api.put(`/api/notes/${item.note_id}/revisions/${item.id}`, {
      encryptedContent: await vault.encryptJson(rewritten, CONTEXTS.noteContent(item.note_id), {
        revision: revision.encrypted_content.revision ?? revision.revision,
      }),
      encryptedSummary: await vault.encryptJson(summary, CONTEXTS.noteSummary(item.note_id)),
      blobIds: blobIdsForSave(rewritten),
    })
    revisionsDone += 1
    onProgress({ phase: 'history', done: revisionsDone, total: revisions.length })
  }

  // History entries already in the current format but with unknown refs.
  const rewrittenRevisions = new Set(revisions.map((item) => item.id))
  const revisionRefs = []
  for (const entry of (await api.get('/api/blobs/refs/unknown')).revisions) {
    if (rewrittenRevisions.has(entry.id)) {
      continue
    }
    const { revision } = await api.get(`/api/notes/${entry.noteId}/revisions/${entry.id}`)
    const content = await vault.decryptJson(revision.encrypted_content, CONTEXTS.noteContent(entry.noteId))
    revisionRefs.push({ id: entry.id, blobIds: blobIdsForSave(content) })
  }
  if (revisionRefs.length) {
    await api.post('/api/blobs/refs/reconcile', { revisions: revisionRefs })
  }

  // Profile (and its picture).
  const me = await api.get('/api/auth/me')
  const profile = await decryptProfile(vault, me.encryptedProfile)
  const pictureReference = profile.profile_picture_blob_id
    ? {
        blobId: String(profile.profile_picture_blob_id),
        blobUuid: profile.profile_picture_blob_uuid,
        blobVersion: profile.profile_picture_blob_version,
        keyId: profile.profile_picture_key_id,
        mimeType: profile.profile_picture_mime_type,
      }
    : null
  if (status.pending.profile || !me.profileRefKnown || (pictureReference && needsBlobUpgrade(pictureReference))) {
    let pictureId = pictureReference ? Number(pictureReference.blobId) : null
    if (pictureReference && needsBlobUpgrade(pictureReference)) {
      const uploaded = await reencryptBlob(pictureReference)
      profile.profile_picture_blob_id = uploaded.blobId
      profile.profile_picture_blob_uuid = uploaded.blobUuid
      profile.profile_picture_blob_version = uploaded.blobVersion
      profile.profile_picture_key_id = uploaded.keyId
      pictureId = Number(uploaded.blobId)
    }
    await api.put('/api/users/profile', { encryptedProfile: await encryptProfile(vault, profile), profileBlobId: pictureId })
  }

  const final = await api.get('/api/vault/status')
  if (!final.complete) {
    return { complete: false, pending: final.pending }
  }
  onProgress({ phase: 'finalize' })
  const data = await api.post('/api/vault/rotation/complete')
  return { complete: true, data }
}
