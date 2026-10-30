import { ApiError } from './api.js'
import { uploadAttachment } from './attachments.js'
import { encodeBase64Url } from './base64.js'
import { CONTEXTS, createPasswordWrapping, createRecoveryWrapping, keyFingerprint, randomBytes } from './envelope.js'
import { argon2id as defaultArgon2id } from './kdf.js'
import { assertPasswordStrength, encryptProfile } from './account.js'
import { blobIdsForSave, createEmptyNoteContent, createNoteSummary, extractLegacyReferences, migrateLegacyContent } from './noteContent.js'
import { Vault } from './vault.js'

const STAGE_BATCH = 50
const MAX_STALE_RETRIES = 3

async function sha256Hex(bytes) {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

/**
 * Upgrades a pre-encryption (legacy) account to end-to-end encryption.
 *
 *  - The server's migration set is the source of truth: every note,
 *    trashed ones included (DATA-5).
 *  - Requires a NEW password: the old one was sent to the server in
 *    plaintext by the legacy login (CRYPTO-2).
 *  - Image and link references to old uploads are re-encrypted as blobs
 *    (CRYPTO-3); missing or unowned files become visible placeholders
 *    instead of aborting the upgrade (DATA-5).
 *  - The recovery key is shown and acknowledged BEFORE the server commits,
 *    so a lost response can never leave the user without one (CRYPTO-2).
 *  - Notes are staged in batches; notes edited meanwhile are re-staged and
 *    the atomic switch retried (no edit is overwritten).
 *
 * `acknowledgeRecoveryKey(recoveryKey)` must resolve once the user confirmed
 * saving it (reject to abort - nothing is committed then).
 */
export async function migrateLegacyAccount({
  api,
  newPassword,
  acknowledgeRecoveryKey,
  onProgress = () => {},
  argon2id = defaultArgon2id,
}) {
  assertPasswordStrength(newPassword)

  const raw = randomBytes(32)
  const keyId = await keyFingerprint(raw)
  onProgress({ phase: 'keys' })
  const passwordWrapping = await createPasswordWrapping(newPassword, raw, keyId, { argon2id })
  const recovery = await createRecoveryWrapping(raw, keyId)
  const vault = await Vault.open(raw)

  const uploaded = new Map()
  const byHash = new Map()
  const missing = new Set()
  let set = await api.get('/api/auth/migration-set')
  const owned = new Set(set.files.map((file) => file.filename))
  const migratedFiles = []

  async function resolveFile(filename) {
    if (uploaded.has(filename)) {
      return uploaded.get(filename)
    }
    if (!owned.has(filename)) {
      missing.add(filename)
      return null
    }
    let response
    try {
      response = await api.request(`/api/legacy-uploads/${encodeURIComponent(filename)}`, { raw: true })
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        missing.add(filename)
        return null
      }
      throw error
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const hash = await sha256Hex(bytes)
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
    migratedFiles.push({ filename, blobId: Number(reference.blobId) })
    return named
  }

  async function stageNotes(notes) {
    for (let i = 0; i < notes.length; i += STAGE_BATCH) {
      const batch = []
      for (const note of notes.slice(i, i + STAGE_BATCH)) {
        const source = note.content && typeof note.content === 'object' ? note.content : createEmptyNoteContent()
        const content = await migrateLegacyContent(source, resolveFile)
        batch.push({
          id: note.id,
          sourceRevision: note.revision,
          // The switch bumps each revision by one; bind that final value.
          encryptedContent: await vault.encryptJson(content, CONTEXTS.noteContent(note.id), {
            revision: note.revision + 1,
          }),
          encryptedSummary: await vault.encryptJson(createNoteSummary(content), CONTEXTS.noteSummary(note.id)),
          blobIds: blobIdsForSave(content),
        })
      }
      await api.post('/api/auth/migration/stage', { notes: batch })
      onProgress({ phase: 'notes', done: Math.min(i + STAGE_BATCH, notes.length), total: notes.length })
    }
  }

  onProgress({ phase: 'files', total: set.files.length })
  await stageNotes(set.notes)

  let profileReference = null
  if (set.profile.profile_picture) {
    profileReference = await resolveFile(set.profile.profile_picture)
  }
  const encryptedProfile = await encryptProfile(vault, {
    first_name: set.profile.first_name,
    last_name: set.profile.last_name,
    profile_picture_blob_id: profileReference?.blobId || null,
    profile_picture_blob_uuid: profileReference?.blobUuid || null,
    profile_picture_blob_version: profileReference?.blobVersion || null,
    profile_picture_key_id: profileReference?.keyId || null,
    profile_picture_mime_type: profileReference?.mimeType || null,
  })

  onProgress({ phase: 'acknowledge' })
  await acknowledgeRecoveryKey(recovery.recoveryKey)

  const body = {
    ...passwordWrapping,
    recoveryVerifier: recovery.recoveryVerifier,
    wrappedVaultKeyRecovery: recovery.wrappedVaultKeyRecovery,
    encryptedProfile,
    vaultKeyId: keyId,
    profileBlobId: profileReference ? Number(profileReference.blobId) : null,
    migratedFiles,
  }

  for (let attempt = 0; ; attempt += 1) {
    onProgress({ phase: 'commit' })
    try {
      const data = await api.post('/api/auth/migrate', body)
      const referencedFiles = new Set()
      for (const note of set.notes) {
        for (const filename of extractLegacyReferences(note.content)) {
          referencedFiles.add(filename)
        }
      }
      return {
        data,
        vault,
        recoveryKey: recovery.recoveryKey,
        summary: {
          notes: set.notes.length,
          trashedNotes: set.notes.filter((note) => note.deleted_at).length,
          filesMigrated: migratedFiles.length,
          missingFiles: [...missing].filter((name) => referencedFiles.has(name) || name === set.profile.profile_picture),
        },
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'MIGRATION_STALE' || attempt >= MAX_STALE_RETRIES) {
        throw error
      }
      // Notes changed (or appeared) while staging: re-stage just those.
      set = await api.get('/api/auth/migration-set')
      const changed = new Set([...(error.data?.stale || []), ...(error.data?.missing || [])])
      await stageNotes(set.notes.filter((note) => changed.has(note.id)))
    }
  }
}
