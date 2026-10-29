/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  CONTEXTS,
  MIN_PASSWORD_LENGTH,
  createVaultBootstrap,
  decodeBase64,
  decryptBytes,
  decryptJson,
  decryptProfile,
  derivePasswordMaterial,
  deriveRecoveryVerifier,
  encodeBase64,
  encryptBytes,
  encryptJson,
  encryptProfile,
  unlockVaultWithPassword,
  unlockVaultWithRecoveryKey,
} from '../lib/e2ee.js'
import {
  createNoteSummary,
  extractBlobIdsFromContent,
  migrateLegacyContent,
  normalizeContentForStorage,
} from '../lib/noteContent.js'

const AuthContext = createContext()

async function parseJsonResponse(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function createObjectUrl(bytes, mimeType) {
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || 'application/octet-stream' }))
}

export function AuthProvider({ children }) {
  const [sessionUser, setSessionUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [vaultBootstrap, setVaultBootstrap] = useState(null)
  const [encryptedProfileValue, setEncryptedProfileValue] = useState(null)
  const [profile, setProfile] = useState(null)
  const [pendingRecoveryKey, setPendingRecoveryKey] = useState(null)

  const mountedRef = useRef(true)
  const vaultKeyRef = useRef(null)
  const blobUrlCacheRef = useRef(new Map())

  const revokeBlobUrl = useCallback((blobId) => {
    const cached = blobUrlCacheRef.current.get(String(blobId))
    if (cached?.url) {
      URL.revokeObjectURL(cached.url)
    }
    blobUrlCacheRef.current.delete(String(blobId))
  }, [])

  const clearBlobUrlCache = useCallback(() => {
    for (const { url } of blobUrlCacheRef.current.values()) {
      if (url) {
        URL.revokeObjectURL(url)
      }
    }
    blobUrlCacheRef.current.clear()
  }, [])

  const clearVaultState = useCallback(() => {
    vaultKeyRef.current = null
    clearBlobUrlCache()
    setVaultBootstrap(null)
    setEncryptedProfileValue(null)
    setProfile(null)
  }, [clearBlobUrlCache])

  async function requestJson(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'include',
      ...options,
    })
    const data = await parseJsonResponse(res)
    if (!res.ok) {
      throw new Error(data?.error || 'Request failed')
    }
    return data
  }

  async function resolveEncryptedBlobUrl(blobId, mimeTypeHint, signal) {
    const cacheKey = String(blobId)
    if (blobUrlCacheRef.current.has(cacheKey)) {
      return blobUrlCacheRef.current.get(cacheKey).url
    }

    if (!vaultKeyRef.current) {
      throw new Error('Vault is locked')
    }

    const res = await fetch(`/api/blobs/${blobId}`, {
      credentials: 'include',
      signal,
    })
    if (!res.ok) {
      const data = await parseJsonResponse(res)
      throw new Error(data?.error || 'Failed to load encrypted file')
    }

    const cipherBytes = new Uint8Array(await res.arrayBuffer())
    const envelope = {
      version: parseInt(res.headers.get('x-blob-version') || '1', 10),
      algorithm: res.headers.get('x-blob-algorithm') || 'AES-256-GCM',
      context: CONTEXTS.blob,
      iv: res.headers.get('x-blob-iv'),
      ciphertext: encodeBase64(cipherBytes),
    }

    // Prefer the mime type carried inside encrypted data (note attrs /
    // profile) over the server-visible header, which is generic for new blobs.
    const mimeType = mimeTypeHint || res.headers.get('x-blob-mime-type') || 'application/octet-stream'
    const plaintextBytes = await decryptBytes(vaultKeyRef.current, envelope, CONTEXTS.blob)
    const url = createObjectUrl(plaintextBytes, mimeType)

    blobUrlCacheRef.current.set(cacheKey, { url, mimeType })
    return url
  }

  async function materializeProfile(decryptedProfile) {
    if (!decryptedProfile) {
      return null
    }

    if (decryptedProfile.profile_picture_blob_id) {
      return {
        ...decryptedProfile,
        profile_picture: await resolveEncryptedBlobUrl(
          decryptedProfile.profile_picture_blob_id,
          decryptedProfile.profile_picture_mime_type
        ),
      }
    }

    return {
      ...decryptedProfile,
      profile_picture: null,
    }
  }

  async function adoptUnlockedE2EE(payload, vaultKey) {
    vaultKeyRef.current = vaultKey
    setSessionUser(payload.user)
    setVaultBootstrap(payload.vaultBootstrap)
    setEncryptedProfileValue(payload.encryptedProfile)

    const decryptedProfile = payload.encryptedProfile
      ? await decryptProfile(vaultKey, payload.encryptedProfile)
      : { first_name: '', last_name: '', profile_picture_blob_id: null, profile_picture_mime_type: null }
    const hydratedProfile = await materializeProfile(decryptedProfile)

    if (mountedRef.current) {
      setProfile(hydratedProfile)
    }
  }

  const adoptLockedE2EE = useCallback((payload) => {
    clearVaultState()
    setSessionUser(payload.user)
    setVaultBootstrap(payload.vaultBootstrap)
    setEncryptedProfileValue(payload.encryptedProfile)
  }, [clearVaultState])

  const adoptLegacySession = useCallback((user) => {
    clearVaultState()
    setSessionUser(user)
  }, [clearVaultState])

  async function uploadEncryptedBlobData({ bytes, mimeType }) {
    if (!vaultKeyRef.current) {
      throw new Error('Unlock the vault first')
    }

    const envelope = await encryptBytes(vaultKeyRef.current, bytes, CONTEXTS.blob)
    // The real mime type and purpose stay inside encrypted content; the
    // server only ever sees generic blob metadata.
    const res = await fetch('/api/blobs', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Blob-IV': envelope.iv,
        'X-Blob-Kind': 'blob',
        'X-Blob-Mime-Type': 'application/octet-stream',
        'X-Blob-Algorithm': envelope.algorithm,
        'X-Blob-Version': String(envelope.version),
      },
      body: decodeBase64(envelope.ciphertext),
    })

    const data = await parseJsonResponse(res)
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to upload encrypted file')
    }

    const blobId = String(data.blob.id)
    const url = createObjectUrl(bytes, mimeType)
    blobUrlCacheRef.current.set(blobId, { url, mimeType })

    return {
      blobId,
      mimeType,
      url,
    }
  }

  async function uploadEncryptedBlob(file) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const mimeType = file.type || 'application/octet-stream'
    return uploadEncryptedBlobData({ bytes, mimeType })
  }

  async function deleteBlob(blobId) {
    if (!blobId) {
      return
    }

    try {
      await fetch(`/api/blobs/${blobId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
    } finally {
      revokeBlobUrl(blobId)
    }
  }

  function requireNoteId(noteId) {
    if (noteId === null || typeof noteId === 'undefined' || noteId === '') {
      throw new Error('A note id is required to bind encrypted data')
    }
    return String(noteId)
  }

  async function encryptNoteContent(content, noteId) {
    if (!vaultKeyRef.current) {
      throw new Error('Unlock the vault first')
    }

    const normalizedContent = normalizeContentForStorage(content)
    return encryptJson(vaultKeyRef.current, normalizedContent, CONTEXTS.noteContent(requireNoteId(noteId)))
  }

  async function decryptNoteContent(note) {
    if (!note?.encrypted_content) {
      return note?.content || null
    }

    if (!vaultKeyRef.current) {
      throw new Error('Unlock the vault first')
    }

    return decryptJson(
      vaultKeyRef.current,
      note.encrypted_content,
      CONTEXTS.noteContent(requireNoteId(note.id))
    )
  }

  async function encryptNoteSummary(summary, noteId) {
    if (!vaultKeyRef.current) {
      throw new Error('Unlock the vault first')
    }

    return encryptJson(vaultKeyRef.current, summary, CONTEXTS.noteSummary(requireNoteId(noteId)))
  }

  async function decryptNoteSummary(encryptedSummary, noteId) {
    if (!encryptedSummary) {
      return null
    }

    if (!vaultKeyRef.current) {
      throw new Error('Unlock the vault first')
    }

    return decryptJson(
      vaultKeyRef.current,
      encryptedSummary,
      CONTEXTS.noteSummary(requireNoteId(noteId))
    )
  }

  async function encryptNoteSearchText(noteId, value) {
    if (!vaultKeyRef.current) {
      throw new Error('Unlock the vault first')
    }

    return encryptJson(vaultKeyRef.current, value, CONTEXTS.noteSearch(requireNoteId(noteId)))
  }

  async function decryptNoteSearchText(noteId, encryptedValue) {
    if (!encryptedValue) {
      return null
    }

    if (!vaultKeyRef.current) {
      throw new Error('Unlock the vault first')
    }

    return decryptJson(
      vaultKeyRef.current,
      encryptedValue,
      CONTEXTS.noteSearch(requireNoteId(noteId))
    )
  }

  async function migrateLegacyBlob(filename) {
    const res = await fetch(`/api/legacy-uploads/${encodeURIComponent(filename)}`, {
      credentials: 'include',
    })

    if (!res.ok) {
      const data = await parseJsonResponse(res)
      throw new Error(data?.error || 'Failed to load legacy file')
    }

    const bytes = new Uint8Array(await res.arrayBuffer())
    const mimeType = res.headers.get('content-type') || 'application/octet-stream'
    return uploadEncryptedBlobData({ bytes, mimeType })
  }

  async function migrateLegacyAccount({ legacyUser, password }) {
    const notesPayload = await requestJson('/api/notes')
    const bootstrap = await createVaultBootstrap(password)

    vaultKeyRef.current = bootstrap.vaultKey

    const migratedNotes = await Promise.all(
      (notesPayload.notes || []).map(async (note) => {
        const migratedContent = await migrateLegacyContent(note.content, (filename) =>
          migrateLegacyBlob(filename)
        )
        const normalizedContent = normalizeContentForStorage(migratedContent)

        return {
          id: note.id,
          encryptedContent: await encryptJson(
            bootstrap.vaultKey,
            normalizedContent,
            CONTEXTS.noteContent(String(note.id))
          ),
          encryptedSummary: await encryptJson(
            bootstrap.vaultKey,
            createNoteSummary(normalizedContent),
            CONTEXTS.noteSummary(String(note.id))
          ),
        }
      })
    )

    let profilePictureBlob = null
    if (legacyUser.profile_picture) {
      profilePictureBlob = await migrateLegacyBlob(legacyUser.profile_picture)
    }

    const encryptedProfile = await encryptProfile(bootstrap.vaultKey, {
      first_name: legacyUser.first_name || '',
      last_name: legacyUser.last_name || '',
      profile_picture_blob_id: profilePictureBlob?.blobId || null,
      profile_picture_mime_type: profilePictureBlob?.mimeType || null,
    })

    const migratedPayload = await requestJson('/api/auth/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authSalt: bootstrap.authSalt,
        kdfParams: bootstrap.kdfParams,
        authVerifier: bootstrap.authVerifier,
        recoveryVerifier: bootstrap.recoveryVerifier,
        wrappedVaultKey: bootstrap.wrappedVaultKey,
        wrappedVaultKeyRecovery: bootstrap.wrappedVaultKeyRecovery,
        encryptedProfile,
        notes: migratedNotes,
      }),
    })

    await adoptUnlockedE2EE(migratedPayload, bootstrap.vaultKey)
    setPendingRecoveryKey(bootstrap.recoveryKey)

    return {
      user: migratedPayload.user,
      migrated: true,
      recoveryKey: bootstrap.recoveryKey,
    }
  }

  useEffect(() => {
    mountedRef.current = true

    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' })
        if (!res.ok) {
          return
        }

        const data = await parseJsonResponse(res)
        if (data?.user?.auth_mode === 'e2ee') {
          adoptLockedE2EE(data)
        } else if (data?.user) {
          adoptLegacySession(data.user)
        }
      } catch {
        // not authenticated
      } finally {
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    }

    checkAuth()

    return () => {
      mountedRef.current = false
      clearBlobUrlCache()
    }
  }, [adoptLegacySession, adoptLockedE2EE, clearBlobUrlCache])

  function assertPasswordStrength(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long`)
    }
  }

  async function signup(email, first_name, last_name, password) {
    assertPasswordStrength(password)
    const bootstrap = await createVaultBootstrap(password)
    const encryptedProfile = await encryptProfile(bootstrap.vaultKey, {
      first_name,
      last_name,
      profile_picture_blob_id: null,
      profile_picture_mime_type: null,
    })

    const data = await requestJson('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        authSalt: bootstrap.authSalt,
        kdfParams: bootstrap.kdfParams,
        authVerifier: bootstrap.authVerifier,
        recoveryVerifier: bootstrap.recoveryVerifier,
        wrappedVaultKey: bootstrap.wrappedVaultKey,
        wrappedVaultKeyRecovery: bootstrap.wrappedVaultKeyRecovery,
        encryptedProfile,
      }),
    })

    await adoptUnlockedE2EE(data, bootstrap.vaultKey)
    setPendingRecoveryKey(bootstrap.recoveryKey)
    return { user: data.user, recoveryKey: bootstrap.recoveryKey }
  }

  async function login(email, password) {
    const prelogin = await requestJson('/api/auth/prelogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })

    if (prelogin.authMode === 'e2ee') {
      // Prelogin only supplies salt + KDF params; the wrapped vault key is
      // released by the server after the auth verifier checks out.
      const { authSecret, keyEncryptionKey } = await derivePasswordMaterial(
        password,
        prelogin.salt,
        prelogin.kdfParams
      )

      const data = await requestJson('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, authSecret }),
      })

      let vaultKey

      try {
        vaultKey = await decryptBytes(
          keyEncryptionKey,
          data.vaultBootstrap.wrappedVaultKey,
          CONTEXTS.vaultKeyPassword
        )
      } catch {
        throw new Error('Unable to unlock the vault with this password')
      }

      await adoptUnlockedE2EE(data, vaultKey)
      return { user: data.user }
    }

    const data = await requestJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    adoptLegacySession(data.user)

    try {
      return await migrateLegacyAccount({ legacyUser: data.user, password })
    } catch (error) {
      await logout()
      throw new Error(`Legacy account migration failed: ${error.message}`)
    }
  }

  // Covers state (b) "authenticated + vault locked" -> (c) "authenticated +
  // vault open".
  async function unlockVault(password) {
    if (!vaultBootstrap || !encryptedProfileValue) {
      throw new Error('No encrypted vault is available')
    }

    let vaultKey

    try {
      const unlocked = await unlockVaultWithPassword(password, vaultBootstrap)
      vaultKey = unlocked.vaultKey
    } catch {
      throw new Error('Invalid password')
    }

    await adoptUnlockedE2EE(
      {
        user: sessionUser,
        vaultBootstrap,
        encryptedProfile: encryptedProfileValue,
      },
      vaultKey
    )
  }

  async function recoverAccount(email, recoveryKey, newPassword) {
    assertPasswordStrength(newPassword)

    // The raw recovery key never leaves this device: the server sees only a
    // one-way verifier, and releases the recovery-wrapped vault key after
    // that verifier checks out.
    const derivedVerifier = await deriveRecoveryVerifier(recoveryKey)

    const begin = await requestJson('/api/auth/recover/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, recoveryVerifier: derivedVerifier }),
    })

    let vaultKey

    try {
      vaultKey = await unlockVaultWithRecoveryKey(recoveryKey, begin.wrappedVaultKeyRecovery)
    } catch {
      throw new Error('Invalid recovery key')
    }

    const bootstrap = await createVaultBootstrap(newPassword, vaultKey)

    const data = await requestJson('/api/auth/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        recoveryVerifier: derivedVerifier,
        authSalt: bootstrap.authSalt,
        kdfParams: bootstrap.kdfParams,
        authVerifier: bootstrap.authVerifier,
        nextRecoveryVerifier: bootstrap.recoveryVerifier,
        wrappedVaultKey: bootstrap.wrappedVaultKey,
        wrappedVaultKeyRecovery: bootstrap.wrappedVaultKeyRecovery,
      }),
    })

    await adoptUnlockedE2EE(data, vaultKey)
    setPendingRecoveryKey(bootstrap.recoveryKey)
    return { user: data.user, recoveryKey: bootstrap.recoveryKey }
  }

  async function rekeyVault(currentPassword, newPassword) {
    if (!vaultBootstrap || !vaultKeyRef.current) {
      throw new Error('Unlock the vault first')
    }

    assertPasswordStrength(newPassword)

    let currentAuthSecret

    try {
      const unlocked = await unlockVaultWithPassword(currentPassword, vaultBootstrap)
      currentAuthSecret = unlocked.authSecret
    } catch {
      throw new Error('Invalid current password')
    }

    const bootstrap = await createVaultBootstrap(newPassword, vaultKeyRef.current)

    const data = await requestJson('/api/auth/rekey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentAuthSecret,
        authSalt: bootstrap.authSalt,
        kdfParams: bootstrap.kdfParams,
        authVerifier: bootstrap.authVerifier,
        nextRecoveryVerifier: bootstrap.recoveryVerifier,
        wrappedVaultKey: bootstrap.wrappedVaultKey,
        wrappedVaultKeyRecovery: bootstrap.wrappedVaultKeyRecovery,
      }),
    })

    await adoptUnlockedE2EE(data, vaultKeyRef.current)
    setPendingRecoveryKey(bootstrap.recoveryKey)
    return bootstrap.recoveryKey
  }

  async function logout() {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })

    clearVaultState()
    setSessionUser(null)
  }

  async function saveProfile({ firstName, lastName, file }) {
    if (sessionUser?.auth_mode !== 'e2ee') {
      throw new Error('Encrypted profile updates are unavailable')
    }

    if (!vaultKeyRef.current) {
      throw new Error('Unlock the vault first')
    }

    const currentProfile = profile || {
      first_name: '',
      last_name: '',
      profile_picture_blob_id: null,
      profile_picture_mime_type: null,
      profile_picture: null,
    }

    let previousProfilePictureBlobId = null
    let nextProfile = {
      ...currentProfile,
      first_name: firstName,
      last_name: lastName,
    }

    if (file) {
      const uploadedBlob = await uploadEncryptedBlob(file)
      previousProfilePictureBlobId = currentProfile.profile_picture_blob_id || null
      nextProfile = {
        ...nextProfile,
        profile_picture_blob_id: uploadedBlob.blobId,
        profile_picture_mime_type: uploadedBlob.mimeType,
        profile_picture: uploadedBlob.url,
      }
    }

    const encryptedProfile = await encryptProfile(vaultKeyRef.current, {
      first_name: nextProfile.first_name,
      last_name: nextProfile.last_name,
      profile_picture_blob_id: nextProfile.profile_picture_blob_id || null,
      profile_picture_mime_type: nextProfile.profile_picture_mime_type || null,
    })

    await requestJson('/api/users/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        encryptedProfile,
        previousProfilePictureBlobId,
      }),
    })

    if (
      previousProfilePictureBlobId &&
      previousProfilePictureBlobId !== nextProfile.profile_picture_blob_id
    ) {
      revokeBlobUrl(previousProfilePictureBlobId)
    }

    setEncryptedProfileValue(encryptedProfile)
    setProfile(nextProfile)
    return nextProfile
  }

  function updateUser(updatedUser) {
    setSessionUser(updatedUser)
  }

  function dismissRecoveryKey() {
    setPendingRecoveryKey(null)
  }

  // ── The three states, named ─────────────────────────────────────────────
  // (a) not authenticated:            `user` is null (below).
  // (b) authenticated + vault locked: `vaultLocked` true.
  // (c) authenticated + vault open:   `vaultLocked` false, vaultKeyRef.current set.
  const authMode = sessionUser?.auth_mode || null
  // True whenever we have an e2ee session but no vault key in memory yet;
  // VaultUnlockScreen prompts from this.
  const vaultLocked = authMode === 'e2ee' && !vaultKeyRef.current
  const user = sessionUser
    ? authMode === 'e2ee'
      ? {
          ...sessionUser,
          ...(profile || {}),
        }
      : sessionUser
    : null

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        authMode,
        vaultLocked,
        pendingRecoveryKey,
        login,
        signup,
        logout,
        unlockVault,
        recoverAccount,
        rekeyVault,
        saveProfile,
        updateUser,
        dismissRecoveryKey,
        encryptNoteContent,
        decryptNoteContent,
        encryptNoteSummary,
        decryptNoteSummary,
        encryptNoteSearchText,
        decryptNoteSearchText,
        uploadEncryptedBlob,
        deleteBlob,
        resolveEncryptedBlobUrl,
        revokeBlobUrl,
        extractBlobIdsFromContent,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
