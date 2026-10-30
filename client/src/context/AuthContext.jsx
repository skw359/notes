/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import * as account from '../lib/account.js'
import { api, onApiEvent } from '../lib/api.js'
import { createAttachmentResolver, uploadFile } from '../lib/attachments.js'
import { getDeviceSettings, setDeviceSettings } from '../lib/deviceSettings.js'
import { prepareKeyRotation, reencryptVault } from '../lib/keyRotation.js'
import { migrateLegacyAccount } from '../lib/legacyMigration.js'
import { clearUserData, countOutboxEntries } from '../lib/persistentNoteCache.js'

const AuthContext = createContext(null)

const EMPTY_PROFILE = { first_name: '', last_name: '', profile_picture_blob_id: null }

function pictureReference(profile) {
  return profile?.profile_picture_blob_id
    ? {
        blobId: String(profile.profile_picture_blob_id),
        blobUuid: profile.profile_picture_blob_uuid || null,
        blobVersion: profile.profile_picture_blob_version || null,
        keyId: profile.profile_picture_key_id || null,
        mimeType: profile.profile_picture_mime_type || 'image/jpeg',
      }
    : null
}

export function AuthProvider({ children }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState(null)
  const [vault, setVault] = useState(null)
  const [profile, setProfile] = useState(null)
  const [pictureUrl, setPictureUrl] = useState(null)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [recoveryPrompt, setRecoveryPrompt] = useState(null)
  const [deviceSettings, setDeviceSettingsState] = useState(getDeviceSettings)
  const [lockNotice, setLockNotice] = useState(null)
  // DATA-5: a legacy user may postpone the upgrade (or retry it after a
  // failure) and keep using the app instead of being logged out.
  const [upgradeDeferred, setUpgradeDeferred] = useState(false)

  const vaultRef = useRef(null)
  const sessionRef = useRef(null)
  const lockHandlers = useRef(new Set())
  const resumeHandlers = useRef(new Set())
  const attachments = useMemo(() => createAttachmentResolver({ api }), [])

  useEffect(() => {
    vaultRef.current = vault
  }, [vault])
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  // ── recovery key acknowledgement (CRYPTO-2 / CRYPTO-4) ────────────────
  const requestRecoveryAcknowledgement = useCallback(
    (key, purpose, { cancellable = false } = {}) =>
      new Promise((resolve, reject) => {
        setRecoveryPrompt({
          key,
          purpose,
          cancellable,
          confirm: () => {
            setRecoveryPrompt(null)
            resolve()
          },
          cancel: () => {
            setRecoveryPrompt(null)
            reject(new Error('Cancelled. Nothing was changed.'))
          },
        })
      }),
    []
  )

  // ── session helpers ───────────────────────────────────────────────────
  const adoptSessionPayload = useCallback((payload) => {
    const next = {
      user: payload.user,
      authMode: payload.user.auth_mode,
      bootstrap: payload.vaultBootstrap || null,
      encryptedProfile: payload.encryptedProfile ?? null,
      profileBlobId: payload.profileBlobId ?? null,
      migrationRequired: Boolean(payload.migrationRequired),
    }
    sessionRef.current = next
    setSession(next)
    setSessionExpired(false)
  }, [])

  const adoptVault = useCallback(
    async (nextVault, payload) => {
      vaultRef.current = nextVault
      attachments.setVault(nextVault)
      setVault(nextVault)
      adoptSessionPayload(payload)
      setLockNotice(null)
      try {
        setProfile(await account.decryptProfile(nextVault, payload.encryptedProfile))
      } catch {
        setProfile({ ...EMPTY_PROFILE })
      }
    },
    [adoptSessionPayload, attachments]
  )

  const clearVault = useCallback(() => {
    vaultRef.current?.lock()
    vaultRef.current = null
    attachments.setVault(null)
    setVault(null)
    setProfile(null)
    setPictureUrl(null)
    attachments.clear()
  }, [attachments])

  // Lets the dashboard persist unsent edits (encrypted) before the key is
  // dropped. A handler returning false vetoes the lock.
  const registerLockHandler = useCallback((handler) => {
    lockHandlers.current.add(handler)
    return () => lockHandlers.current.delete(handler)
  }, [])

  const registerResumeHandler = useCallback((handler) => {
    resumeHandlers.current.add(handler)
    return () => resumeHandlers.current.delete(handler)
  }, [])

  const runLockHandlers = useCallback(async () => {
    for (const handler of lockHandlers.current) {
      if ((await handler()) === false) {
        return false
      }
    }
    return true
  }, [])

  // ── initial load ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    api
      .get('/api/auth/me')
      .then((payload) => {
        if (!cancelled) {
          adoptSessionPayload(payload)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [adoptSessionPayload])

  // DATA-2: an expired session no longer silently drops saves. With the
  // vault open, the app asks for the password and keeps everything in place.
  useEffect(
    () =>
      onApiEvent((event) => {
        if (event.type !== 'unauthorized' || !sessionRef.current) {
          return
        }
        if (vaultRef.current || sessionRef.current.authMode === 'legacy') {
          setSessionExpired(true)
        } else {
          sessionRef.current = null
          setSession(null)
        }
      }),
    []
  )

  // Decrypted profile picture.
  useEffect(() => {
    const reference = pictureReference(profile)
    if (!reference || !vault) {
      return undefined
    }
    let cancelled = false
    attachments
      .resolve(reference)
      .then((url) => {
        if (!cancelled) {
          setPictureUrl(url)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPictureUrl(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [attachments, profile, vault])

  // ── authentication flows ──────────────────────────────────────────────
  const login = useCallback(
    async (email, password) => {
      const preloginData = await account.prelogin(api, email)
      if (preloginData.authMode === 'legacy') {
        adoptSessionPayload(await api.post('/api/auth/login', { email, password }))
        return { legacy: true }
      }
      const { data, vault: opened } = await account.loginEncrypted({ api, email, password, preloginData })
      await adoptVault(opened, data)
      return { legacy: false }
    },
    [adoptSessionPayload, adoptVault]
  )

  const signup = useCallback(
    async ({ email, password, firstName, lastName, inviteCode }) => {
      const { data, vault: opened, recoveryKey } = await account.signup({
        api,
        email,
        password,
        firstName,
        lastName,
        inviteCode,
      })
      await adoptVault(opened, data)
      await requestRecoveryAcknowledgement(recoveryKey, 'signup')
    },
    [adoptVault, requestRecoveryAcknowledgement]
  )

  const unlock = useCallback(
    async (password) => {
      const current = sessionRef.current
      const opened = await account.unlockWithPassword({ api, bootstrap: current.bootstrap, password })
      await adoptVault(opened, {
        user: current.user,
        vaultBootstrap: current.bootstrap,
        encryptedProfile: current.encryptedProfile,
        profileBlobId: current.profileBlobId,
      })
      for (const handler of resumeHandlers.current) {
        handler()
      }
    },
    [adoptVault]
  )

  // DATA-2: sign in again after the session expired, keeping the open vault.
  const reauthenticate = useCallback(
    async (password) => {
      const current = sessionRef.current
      const payload = await account.reauthenticate({ api, email: current.user.email, password })
      const rotatedElsewhere =
        vaultRef.current &&
        payload.vaultBootstrap?.vaultKeyId &&
        payload.vaultBootstrap.vaultKeyId !== vaultRef.current.currentKeyId
      if (rotatedElsewhere) {
        // The key was rotated on another device: unlock again with it.
        clearVault()
        adoptSessionPayload(payload)
        return { relock: true }
      }
      setSession((previous) => ({ ...previous, bootstrap: payload.vaultBootstrap || previous.bootstrap }))
      setSessionExpired(false)
      for (const handler of resumeHandlers.current) {
        handler()
      }
      return { relock: false }
    },
    [adoptSessionPayload, clearVault]
  )

  const lock = useCallback(
    async (reason = 'manual') => {
      if (!vaultRef.current) {
        return true
      }
      if (!(await runLockHandlers())) {
        return false
      }
      clearVault()
      setLockNotice(reason === 'idle' ? 'Locked after inactivity.' : null)
      return true
    },
    [clearVault, runLockHandlers]
  )

  const logout = useCallback(async () => {
    const current = sessionRef.current
    await runLockHandlers()
    try {
      await api.post('/api/auth/logout')
    } catch {
      // the local logout still happens
    }
    // SEC-11: no notes metadata or ciphertext is left behind on a shared
    // device, except unsent edits, which are never discarded silently.
    if (current?.user?.id && !getDeviceSettings().keepCacheOnLogout) {
      await clearUserData(current.user.id)
    }
    clearVault()
    sessionRef.current = null
    setSession(null)
    setSessionExpired(false)
  }, [clearVault, runLockHandlers])

  const unsentEditCount = useCallback(async () => {
    const current = sessionRef.current
    return current?.user?.id ? countOutboxEntries(current.user.id) : 0
  }, [])

  const recover = useCallback(
    async ({ email, recoveryKey, newPassword }) => {
      const prepared = await account.prepareRecovery({ api, email, recoveryKey, newPassword })
      try {
        await requestRecoveryAcknowledgement(prepared.recoveryKey, 'recovery', { cancellable: true })
      } catch (error) {
        prepared.cancel()
        throw error
      }
      const { data, vault: opened } = await prepared.commit()
      await adoptVault(opened, data)
    },
    [adoptVault, requestRecoveryAcknowledgement]
  )

  const changePassword = useCallback(async (currentPassword, newPassword) => {
    const current = sessionRef.current
    const payload = await account.changePassword({ api, bootstrap: current.bootstrap, currentPassword, newPassword })
    setSession((previous) => ({ ...previous, bootstrap: payload.vaultBootstrap }))
  }, [])

  const regenerateRecoveryKey = useCallback(
    async (password) => {
      const current = sessionRef.current
      const prepared = await account.prepareNewRecoveryKey({ api, bootstrap: current.bootstrap, password })
      await requestRecoveryAcknowledgement(prepared.recoveryKey, 'regenerate', { cancellable: true })
      const result = await prepared.commit()
      setSession((previous) => ({
        ...previous,
        bootstrap: { ...previous.bootstrap, recoveryKeyUpdatedAt: result.recoveryKeyUpdatedAt },
      }))
    },
    [requestRecoveryAcknowledgement]
  )

  const deleteAccount = useCallback(
    async (password) => {
      const current = sessionRef.current
      await account.deleteAccount({ api, bootstrap: current.bootstrap, password })
      await clearUserData(current.user.id, { includeOutbox: true })
      clearVault()
      sessionRef.current = null
      setSession(null)
    },
    [clearVault]
  )

  const saveProfile = useCallback(
    async ({ firstName, lastName, file }) => {
      const currentVault = vaultRef.current
      if (!currentVault) {
        throw new Error('Unlock the vault first')
      }
      let next = { ...(profile || EMPTY_PROFILE), first_name: firstName, last_name: lastName }
      if (file) {
        const uploaded = await uploadFile({ api, vault: currentVault, file })
        next = {
          ...next,
          profile_picture_blob_id: uploaded.blobId,
          profile_picture_blob_uuid: uploaded.blobUuid,
          profile_picture_blob_version: uploaded.blobVersion,
          profile_picture_key_id: uploaded.keyId,
          profile_picture_mime_type: uploaded.mimeType,
        }
        attachments.remember(uploaded.blobId, new Uint8Array(await file.arrayBuffer()), uploaded.mimeType)
      }
      const encryptedProfile = await account.encryptProfile(currentVault, next)
      const profileBlobId = next.profile_picture_blob_id ? Number(next.profile_picture_blob_id) : null
      await api.put('/api/users/profile', { encryptedProfile, profileBlobId })
      setProfile(next)
      setSession((previous) => ({ ...previous, encryptedProfile, profileBlobId }))
    },
    [attachments, profile]
  )

  // ── legacy upgrade, rotation, format upgrade ──────────────────────────
  const upgradeLegacyAccount = useCallback(
    async (newPassword, onProgress) => {
      const result = await migrateLegacyAccount({
        api,
        newPassword,
        onProgress,
        acknowledgeRecoveryKey: (key) => requestRecoveryAcknowledgement(key, 'migration', { cancellable: true }),
      })
      await adoptVault(result.vault, result.data)
      return result.summary
    },
    [adoptVault, requestRecoveryAcknowledgement]
  )

  const upgradeEncryption = useCallback(async (onProgress) => {
    const result = await reencryptVault({ api, vault: vaultRef.current, onProgress })
    if (result.complete) {
      vaultRef.current.minEnvelopeVersion = 3
      setSession((previous) => ({ ...previous, bootstrap: result.data.vaultBootstrap }))
    }
    return result
  }, [])

  const rotateKey = useCallback(
    async ({ currentPassword, newPassword }, onProgress) => {
      const current = sessionRef.current
      const prepared = await prepareKeyRotation({ api, bootstrap: current.bootstrap, currentPassword, newPassword })
      try {
        await requestRecoveryAcknowledgement(prepared.recoveryKey, 'rotation', { cancellable: true })
      } catch (error) {
        prepared.cancel()
        throw error
      }
      await runLockHandlers()
      const { data, vault: rotated } = await prepared.commit()
      await adoptVault(rotated, data)
      const result = await reencryptVault({ api, vault: rotated, onProgress })
      if (result.complete) {
        rotated.minEnvelopeVersion = 3
        setSession((previous) => ({ ...previous, bootstrap: result.data.vaultBootstrap }))
      }
      return result
    },
    [adoptVault, requestRecoveryAcknowledgement, runLockHandlers]
  )

  const updateDeviceSettings = useCallback((patch) => {
    setDeviceSettingsState(setDeviceSettings(patch))
  }, [])

  // ── idle auto-lock (SEC-11) ───────────────────────────────────────────
  useEffect(() => {
    const minutes = deviceSettings.autoLockMinutes
    if (!vault || !minutes) {
      return undefined
    }
    let lastActivity = Date.now()
    const touch = () => {
      lastActivity = Date.now()
    }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart']
    for (const name of events) {
      window.addEventListener(name, touch, { passive: true })
    }
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity >= minutes * 60 * 1000) {
        void lock('idle')
      }
    }, 30 * 1000)
    return () => {
      for (const name of events) {
        window.removeEventListener(name, touch)
      }
      window.clearInterval(timer)
    }
  }, [deviceSettings.autoLockMinutes, lock, vault])

  const authMode = session?.authMode || null
  const vaultLocked = authMode === 'e2ee' && !vault
  const user = session
    ? authMode === 'e2ee'
      ? { ...session.user, ...(profile || {}), profile_picture: pictureUrl }
      : { ...session.user, profile_picture: null }
    : null

  const value = {
    loading,
    user,
    session,
    authMode,
    vault,
    vaultLocked,
    profile,
    sessionExpired,
    lockNotice,
    recoveryPrompt,
    upgradeDeferred,
    setUpgradeDeferred,
    attachments,
    deviceSettings,
    api,
    login,
    signup,
    unlock,
    lock,
    logout,
    reauthenticate,
    recover,
    changePassword,
    regenerateRecoveryKey,
    deleteAccount,
    saveProfile,
    upgradeLegacyAccount,
    upgradeEncryption,
    rotateKey,
    unsentEditCount,
    updateDeviceSettings,
    registerLockHandler,
    registerResumeHandler,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
