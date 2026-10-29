import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import toast from 'react-hot-toast'
import Header from '../components/Header.jsx'
import NotesSidebar from '../components/NotesSidebar.jsx'
import VaultUnlockScreen from '../components/VaultUnlockScreen.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { createEmptyNoteContent } from '../lib/e2ee.js'
import {
  EMPTY_NOTE_SUMMARY,
  createNoteSearchText,
  createNoteSummary,
  getSummarySearchText,
} from '../lib/noteContent.js'
import {
  deleteCachedNote,
  deleteCachedSearchEntry,
  getCachedNote,
  getCachedSearchEntry,
  getCachedSummaryList,
  setCachedNote,
  setCachedSearchEntry,
  setCachedSummaryList,
} from '../lib/persistentNoteCache.js'

const NoteEditor = lazy(() => import('../components/NoteEditor.jsx'))

function getAdjacentNoteId(notes, activeId, direction) {
  if (!notes.length) {
    return null
  }

  const activeIndex = notes.findIndex((note) => note.id === activeId)

  if (activeIndex === -1) {
    return direction > 0 ? notes[0].id : notes[notes.length - 1].id
  }

  const nextIndex = Math.min(Math.max(activeIndex + direction, 0), notes.length - 1)
  return notes[nextIndex].id
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]'
    )
  )
}

function sortNotesByMostRecent(notes) {
  return [...notes].sort((a, b) => {
    const aUpdated = new Date(a.updated_at || 0).getTime()
    const bUpdated = new Date(b.updated_at || 0).getTime()
    if (bUpdated !== aUpdated) return bUpdated - aUpdated

    const aCreated = new Date(a.created_at || 0).getTime()
    const bCreated = new Date(b.created_at || 0).getTime()
    if (bCreated !== aCreated) return bCreated - aCreated

    return (b.id || 0) - (a.id || 0)
  })
}

function sortTrashNotes(notes) {
  return [...notes].sort((a, b) => {
    const aDeleted = new Date(a.deleted_at || 0).getTime()
    const bDeleted = new Date(b.deleted_at || 0).getTime()
    if (bDeleted !== aDeleted) return bDeleted - aDeleted
    return sortNotesByMostRecent([a, b])[0]?.id === a.id ? -1 : 1
  })
}

function normalizeSummary(summary) {
  return {
    title: summary?.title || EMPTY_NOTE_SUMMARY.title,
    preview: summary?.preview || EMPTY_NOTE_SUMMARY.preview,
  }
}

function applySummaryToNote(note, summary) {
  return {
    ...note,
    summary: normalizeSummary(summary),
  }
}

function prioritizeNoteIds(notes, activeNoteId) {
  const recentIds = notes.slice(0, 10).map((note) => String(note.id))
  const seen = new Set()
  const ordered = []

  const pushId = (value) => {
    const key = String(value)
    if (!seen.has(key)) {
      seen.add(key)
      ordered.push(key)
    }
  }

  if (activeNoteId) {
    pushId(activeNoteId)
  }

  for (const noteId of recentIds) {
    pushId(noteId)
  }

  for (const note of notes) {
    pushId(note.id)
  }

  return ordered
}

function noteMatchesQuery(note, query, indexedText) {
  if (!query) {
    return true
  }

  if (getSummarySearchText(note.summary).includes(query)) {
    return true
  }

  return indexedText?.includes(query) || false
}

export default function Dashboard() {
  const {
    user,
    authMode,
    encryptNoteContent,
    decryptNoteContent,
    encryptNoteSummary,
    decryptNoteSummary,
    encryptNoteSearchText,
    decryptNoteSearchText,
    extractBlobIdsFromContent,
    uploadEncryptedBlob,
    deleteBlob,
    resolveEncryptedBlobUrl,
    revokeBlobUrl,
    vaultLocked,
  } = useAuth()

  const [notes, setNotes] = useState([])
  const [activeNoteId, setActiveNoteId] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [notesLoading, setNotesLoading] = useState(true)
  const [trashView, setTrashView] = useState(false)
  const [trashNotes, setTrashNotes] = useState([])
  const [trashLoading, setTrashLoading] = useState(false)
  const [activeTrashNoteId, setActiveTrashNoteId] = useState(null)
  const [editorShouldAutoFocus, setEditorShouldAutoFocus] = useState(false)
  const [activeNoteContent, setActiveNoteContent] = useState(null)
  const [activeNoteContentId, setActiveNoteContentId] = useState(null)
  const [activeNoteLoading, setActiveNoteLoading] = useState(false)
  const [activeTrashNoteContent, setActiveTrashNoteContent] = useState(null)
  const [activeTrashNoteContentId, setActiveTrashNoteContentId] = useState(null)
  const [activeTrashNoteLoading, setActiveTrashNoteLoading] = useState(false)
  const [searchStatus, setSearchStatus] = useState({
    indexedCount: 0,
    totalCount: 0,
    running: false,
  })

  const notesRef = useRef([])
  const trashNotesRef = useRef([])
  const activeNoteIdRef = useRef(null)
  const activeTrashNoteIdRef = useRef(null)
  const rawSummaryListsRef = useRef({ active: null, trash: null })
  const fullNoteCacheRef = useRef(new Map())
  const decryptedBodyCacheRef = useRef(new Map())
  const decryptedBodyOrderRef = useRef([])
  const noteSearchIndexRef = useRef(new Map())
  const indexedNoteIdsRef = useRef(new Set())
  const noteBlobRefsRef = useRef(new Map())
  const summaryBackfillInFlightRef = useRef(new Set())
  const backgroundSyncStateRef = useRef({
    token: 0,
    controllers: new Set(),
  })
  const trashLoadedRef = useRef(false)
  const newNoteRef = useRef(null)
  const deleteNoteRef = useRef(null)
  const arrowNavigationRef = useRef(() => false)

  useEffect(() => {
    notesRef.current = notes
  }, [notes])

  useEffect(() => {
    trashNotesRef.current = trashNotes
  }, [trashNotes])

  useEffect(() => {
    activeNoteIdRef.current = activeNoteId
  }, [activeNoteId])

  useEffect(() => {
    activeTrashNoteIdRef.current = activeTrashNoteId
  }, [activeTrashNoteId])

  const countIndexedNotes = useCallback((noteList) => {
    let count = 0
    for (const note of noteList) {
      if (indexedNoteIdsRef.current.has(String(note.id))) {
        count += 1
      }
    }
    return count
  }, [])

  const updateSearchStatus = useCallback(
    (noteList, running) => {
      setSearchStatus({
        indexedCount: countIndexedNotes(noteList),
        totalCount: noteList.length,
        running,
      })
    },
    [countIndexedNotes]
  )

  const cancelBackgroundSync = useCallback(() => {
    backgroundSyncStateRef.current.token += 1

    for (const controller of backgroundSyncStateRef.current.controllers) {
      controller.abort()
    }

    backgroundSyncStateRef.current.controllers.clear()
    updateSearchStatus(notesRef.current, false)
  }, [updateSearchStatus])

  const clearSessionCaches = useCallback(() => {
    cancelBackgroundSync()
    rawSummaryListsRef.current = { active: null, trash: null }
    fullNoteCacheRef.current.clear()
    decryptedBodyCacheRef.current.clear()
    decryptedBodyOrderRef.current = []
    noteSearchIndexRef.current.clear()
    indexedNoteIdsRef.current.clear()
    noteBlobRefsRef.current.clear()
    summaryBackfillInFlightRef.current.clear()
    trashLoadedRef.current = false
  }, [cancelBackgroundSync])

  const rememberDecryptedBody = useCallback((noteId, content) => {
    const key = String(noteId)
    decryptedBodyCacheRef.current.set(key, content)
    decryptedBodyOrderRef.current = [
      ...decryptedBodyOrderRef.current.filter((existingId) => existingId !== key),
      key,
    ]

    while (decryptedBodyOrderRef.current.length > 10) {
      const evictedKey = decryptedBodyOrderRef.current.shift()
      if (evictedKey) {
        decryptedBodyCacheRef.current.delete(evictedKey)

        const retainedBlobIds = new Set()
        for (const retainedNoteId of decryptedBodyOrderRef.current) {
          const retainedNoteBlobIds = noteBlobRefsRef.current.get(retainedNoteId)
          if (!retainedNoteBlobIds) {
            continue
          }

          for (const blobId of retainedNoteBlobIds) {
            retainedBlobIds.add(blobId)
          }
        }

        const evictedBlobIds = noteBlobRefsRef.current.get(evictedKey) || new Set()
        for (const blobId of evictedBlobIds) {
          if (!retainedBlobIds.has(blobId)) {
            revokeBlobUrl(blobId)
          }
        }
      }
    }
  }, [revokeBlobUrl])
  const cacheUserId = authMode === 'e2ee' ? user?.id : null

  const persistSummaryList = useCallback(
    (scope, nextNotes) => {
      const cacheKey = scope === 'trash' ? 'trash' : 'active'
      rawSummaryListsRef.current[cacheKey] = nextNotes

      if (!cacheUserId) {
        return
      }

      void setCachedSummaryList(cacheUserId, cacheKey, nextNotes)
    },
    [cacheUserId]
  )

  const loadCachedSummaryList = useCallback(
    async (scope) => {
      const cacheKey = scope === 'trash' ? 'trash' : 'active'
      if (!cacheUserId) {
        return null
      }

      const cachedNotes = await getCachedSummaryList(cacheUserId, cacheKey)
      if (!cachedNotes) {
        return null
      }

      rawSummaryListsRef.current[cacheKey] = cachedNotes
      return cachedNotes
    },
    [cacheUserId]
  )

  const fetchSummaryListFromServer = useCallback(
    async (scope) => {
      const cacheKey = scope === 'trash' ? 'trash' : 'active'
      const res = await fetch(scope === 'trash' ? '/api/notes/trash' : '/api/notes', {
        credentials: 'include',
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to load notes')
      }

      const nextNotes = data.notes || []
      persistSummaryList(cacheKey, nextNotes)
      return nextNotes
    },
    [persistSummaryList]
  )

  const materializeRawSummaryList = useCallback(
    async (scope, rawNotes) => {
      if (authMode === 'e2ee') {
        const materialized = await Promise.all(
          rawNotes.map(async (note) =>
            applySummaryToNote(note, await decryptNoteSummary(note.encrypted_summary, note.id))
          )
        )

        return scope === 'trash' ? sortTrashNotes(materialized) : sortNotesByMostRecent(materialized)
      }

      const materialized = rawNotes.map((note) => applySummaryToNote(note, createNoteSummary(note.content)))
      return scope === 'trash' ? sortTrashNotes(materialized) : sortNotesByMostRecent(materialized)
    },
    [authMode, decryptNoteSummary]
  )

  const updateRawSummaryList = useCallback(
    (scope, updater) => {
      const cacheKey = scope === 'trash' ? 'trash' : 'active'
      const current = rawSummaryListsRef.current[cacheKey]
      if (!current) {
        return
      }

      persistSummaryList(cacheKey, updater(current))
    },
    [persistSummaryList]
  )

  const persistFullNoteRecord = useCallback(
    (note) => {
      if (!cacheUserId || !note?.id) {
        return
      }

      void setCachedNote(cacheUserId, note)
    },
    [cacheUserId]
  )

  const deletePersistentNoteCaches = useCallback(
    (noteId) => {
      if (!cacheUserId) {
        return
      }

      void Promise.all([
        deleteCachedNote(cacheUserId, noteId),
        deleteCachedSearchEntry(cacheUserId, noteId),
      ])
    },
    [cacheUserId]
  )

  const persistSearchIndex = useCallback(
    async (noteId, updatedAt, searchText) => {
      if (!cacheUserId || typeof searchText !== 'string') {
        return
      }

      try {
        const encryptedSearchText = await encryptNoteSearchText(noteId, searchText)
        await setCachedSearchEntry(cacheUserId, noteId, encryptedSearchText, updatedAt)
      } catch {
        // local cache writes should never block the editor
      }
    },
    [cacheUserId, encryptNoteSearchText]
  )

  const hydrateCachedSearchIndex = useCallback(
    async (noteList) => {
      if (!cacheUserId || vaultLocked || !noteList.length) {
        return
      }

      await Promise.all(
        noteList.map(async (note) => {
          const key = String(note.id)
          if (indexedNoteIdsRef.current.has(key)) {
            return
          }

          try {
            const cachedEntry = await getCachedSearchEntry(cacheUserId, note.id)
            if (
              !cachedEntry ||
              String(cachedEntry.updatedAt || '') !== String(note.updated_at || '')
            ) {
              return
            }

            const cachedSearchText = await decryptNoteSearchText(note.id, cachedEntry.encryptedSearchText)
            if (typeof cachedSearchText !== 'string') {
              return
            }

            noteSearchIndexRef.current.set(key, cachedSearchText)
            indexedNoteIdsRef.current.add(key)
          } catch {
            // ignore unreadable cache entries and let background sync rebuild them
          }
        })
      )
    },
    [cacheUserId, decryptNoteSearchText, vaultLocked]
  )

  const getKnownNoteRecord = useCallback((noteId) => {
    const key = String(noteId)
    return (
      notesRef.current.find((note) => String(note.id) === key) ||
      trashNotesRef.current.find((note) => String(note.id) === key) ||
      rawSummaryListsRef.current.active?.find((note) => String(note.id) === key) ||
      rawSummaryListsRef.current.trash?.find((note) => String(note.id) === key) ||
      null
    )
  }, [])

  const invalidateInMemoryNoteCache = useCallback((noteId) => {
    const key = String(noteId)
    fullNoteCacheRef.current.delete(key)
    decryptedBodyCacheRef.current.delete(key)
    decryptedBodyOrderRef.current = decryptedBodyOrderRef.current.filter((cachedId) => cachedId !== key)
    noteSearchIndexRef.current.delete(key)
    indexedNoteIdsRef.current.delete(key)
  }, [])

  const reconcileCachedNoteState = useCallback(
    (noteList) => {
      for (const note of noteList) {
        const previousNote = getKnownNoteRecord(note.id)
        if (
          previousNote &&
          String(previousNote.updated_at || '') !== String(note.updated_at || '')
        ) {
          invalidateInMemoryNoteCache(note.id)
        }
      }
    },
    [getKnownNoteRecord, invalidateInMemoryNoteCache]
  )

  const applyBackfilledSummary = useCallback(
    (noteId, summary, encryptedSummary) => {
      const normalizedSummary = normalizeSummary(summary)

      setNotes((prev) =>
        sortNotesByMostRecent(
          prev.map((note) =>
            String(note.id) === String(noteId)
              ? {
                  ...note,
                  encrypted_summary: encryptedSummary,
                  summary: normalizedSummary,
                }
              : note
          )
        )
      )

      setTrashNotes((prev) =>
        sortTrashNotes(
          prev.map((note) =>
            String(note.id) === String(noteId)
              ? {
                  ...note,
                  encrypted_summary: encryptedSummary,
                  summary: normalizedSummary,
                }
              : note
          )
        )
      )

      updateRawSummaryList('active', (prev) =>
        prev.map((note) =>
          String(note.id) === String(noteId) ? { ...note, encrypted_summary: encryptedSummary } : note
        )
      )
      updateRawSummaryList('trash', (prev) =>
        prev.map((note) =>
          String(note.id) === String(noteId) ? { ...note, encrypted_summary: encryptedSummary } : note
        )
      )

      const cachedNote = fullNoteCacheRef.current.get(String(noteId))
      if (cachedNote) {
        const updatedCachedNote = {
          ...cachedNote,
          encrypted_summary: encryptedSummary,
        }
        fullNoteCacheRef.current.set(String(noteId), updatedCachedNote)
        persistFullNoteRecord(updatedCachedNote)
      }
    },
    [persistFullNoteRecord, updateRawSummaryList]
  )

  const getFullNoteRecord = useCallback(
    async (noteId, signal) => {
      const key = String(noteId)
      if (fullNoteCacheRef.current.has(key)) {
        return fullNoteCacheRef.current.get(key)
      }

      const knownNote = getKnownNoteRecord(noteId)
      if (cacheUserId) {
        try {
          const cachedNote = await getCachedNote(cacheUserId, noteId)
          if (
            cachedNote &&
            (!knownNote?.updated_at ||
              String(cachedNote.updated_at || '') === String(knownNote.updated_at || ''))
          ) {
            fullNoteCacheRef.current.set(key, cachedNote)
            return cachedNote
          }
        } catch {
          // ignore local cache failures and fall back to the network
        }
      }

      const res = await fetch(`/api/notes/${noteId}`, {
        credentials: 'include',
        signal,
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to load note')
      }

      const note = data.note
      fullNoteCacheRef.current.set(key, note)
      persistFullNoteRecord(note)
      return note
    },
    [cacheUserId, getKnownNoteRecord, persistFullNoteRecord]
  )

  const ensureNoteBodyLoaded = useCallback(
    async (noteId, { scope = 'active', signal, retainDecrypted = false } = {}) => {
      const key = String(noteId)
      const cachedContent = decryptedBodyCacheRef.current.get(key)

      if (cachedContent) {
        if (scope === 'active') {
          const cachedSearchText = createNoteSearchText(cachedContent)
          noteSearchIndexRef.current.set(key, cachedSearchText)
          indexedNoteIdsRef.current.add(key)
          void persistSearchIndex(noteId, getKnownNoteRecord(noteId)?.updated_at, cachedSearchText)
        }
        noteBlobRefsRef.current.set(key, extractBlobIdsFromContent(cachedContent))
        return cachedContent
      }

      const fullNote = await getFullNoteRecord(noteId, signal)
      const content =
        authMode === 'e2ee'
          ? (await decryptNoteContent(fullNote)) || createEmptyNoteContent()
          : fullNote.content || createEmptyNoteContent()
      const searchText = createNoteSearchText(content)

      noteBlobRefsRef.current.set(key, extractBlobIdsFromContent(content))

      if (scope === 'active') {
        noteSearchIndexRef.current.set(key, searchText)
        indexedNoteIdsRef.current.add(key)
        void persistSearchIndex(noteId, fullNote.updated_at, searchText)
      }

      if (retainDecrypted) {
        rememberDecryptedBody(noteId, content)
      }

      if (
        authMode === 'e2ee' &&
        !fullNote.encrypted_summary &&
        !summaryBackfillInFlightRef.current.has(key)
      ) {
        summaryBackfillInFlightRef.current.add(key)

        try {
          const summary = createNoteSummary(content)
          const encryptedSummary = await encryptNoteSummary(summary, noteId)
          const res = await fetch(`/api/notes/${noteId}/summary`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ encryptedSummary }),
          })
          const data = await res.json()
          if (!res.ok) {
            throw new Error(data?.error || 'Failed to save note summary')
          }

          applyBackfilledSummary(noteId, summary, encryptedSummary)
          fullNoteCacheRef.current.set(key, {
            ...fullNote,
            encrypted_summary: encryptedSummary,
          })
        } catch {
          // keep the placeholder summary if the backfill fails
        } finally {
          summaryBackfillInFlightRef.current.delete(key)
        }
      }

      return content
    },
    [
      applyBackfilledSummary,
      authMode,
      decryptNoteContent,
      encryptNoteSummary,
      extractBlobIdsFromContent,
      getFullNoteRecord,
      getKnownNoteRecord,
      persistSearchIndex,
      rememberDecryptedBody,
    ]
  )

  const startBackgroundSync = useCallback(
    (noteList, focusNoteId = null) => {
      if (authMode !== 'e2ee') {
        updateSearchStatus(noteList, false)
        return
      }

      const orderedIds = prioritizeNoteIds(noteList, focusNoteId)
      if (!orderedIds.length) {
        updateSearchStatus(noteList, false)
        return
      }

      cancelBackgroundSync()

      const token = backgroundSyncStateRef.current.token
      const pendingIds = orderedIds.filter((noteId) => !indexedNoteIdsRef.current.has(String(noteId)))
      if (!pendingIds.length) {
        updateSearchStatus(noteList, false)
        return
      }

      updateSearchStatus(noteList, true)

      let index = 0
      const workerCount = Math.min(3, pendingIds.length)

      const worker = async () => {
        while (backgroundSyncStateRef.current.token === token && index < pendingIds.length) {
          const noteId = pendingIds[index]
          index += 1

          const controller = new AbortController()
          backgroundSyncStateRef.current.controllers.add(controller)

          try {
            await ensureNoteBodyLoaded(noteId, {
              scope: 'active',
              signal: controller.signal,
              retainDecrypted: false,
            })
          } catch (error) {
            if (error?.name === 'AbortError') {
              return
            }
          } finally {
            backgroundSyncStateRef.current.controllers.delete(controller)
            if (backgroundSyncStateRef.current.token === token) {
              updateSearchStatus(noteList, true)
            }
          }
        }
      }

      void Promise.all(Array.from({ length: workerCount }, worker)).then(() => {
        if (backgroundSyncStateRef.current.token === token) {
          updateSearchStatus(noteList, false)
        }
      })
    },
    [authMode, cancelBackgroundSync, ensureNoteBodyLoaded, updateSearchStatus]
  )

  const canSafelyDeleteBlobs = useCallback(() => {
    if (!trashLoadedRef.current) {
      return false
    }

    const allKnownNotes = [...notesRef.current, ...trashNotesRef.current]
    return allKnownNotes.every((note) => noteBlobRefsRef.current.has(String(note.id)))
  }, [])

  const collectReferencedBlobIds = useCallback((excludedNoteId) => {
    const ids = new Set()

    for (const note of [...notesRef.current, ...trashNotesRef.current]) {
      if (String(note.id) === String(excludedNoteId)) {
        continue
      }

      const blobIds = noteBlobRefsRef.current.get(String(note.id))
      if (!blobIds) {
        continue
      }

      for (const blobId of blobIds) {
        ids.add(blobId)
      }
    }

    return ids
  }, [])

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault()
        e.stopPropagation()
        newNoteRef.current?.()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault()
        e.stopPropagation()
        deleteNoteRef.current?.()
        return
      }

      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) {
        return
      }

      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
        return
      }

      if (document.querySelector('.modal-overlay') || isEditableTarget(e.target)) {
        return
      }

      const handled = arrowNavigationRef.current?.(e.key === 'ArrowDown' ? 1 : -1)

      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  useEffect(() => {
    if (authMode !== 'e2ee' || !vaultLocked) {
      return
    }

    Promise.all([loadCachedSummaryList('active'), loadCachedSummaryList('trash')]).catch(() => {
      // ignore cache misses and fall through to the network prefetch
    })

    Promise.all([fetchSummaryListFromServer('active'), fetchSummaryListFromServer('trash')]).catch(() => {
      // keep the lock screen quiet if the prefetch fails
    })
  }, [authMode, fetchSummaryListFromServer, loadCachedSummaryList, vaultLocked])

  const fetchNotes = useCallback(async () => {
    setNotesLoading(true)
    let hydratedFromCache = false

    try {
      const cachedRawNotes = await loadCachedSummaryList('active')
      if (cachedRawNotes) {
        const cachedNotes = await materializeRawSummaryList('active', cachedRawNotes)
        await hydrateCachedSearchIndex(cachedNotes)

        const cachedActiveId =
          activeNoteIdRef.current && cachedNotes.some((note) => note.id === activeNoteIdRef.current)
            ? activeNoteIdRef.current
            : cachedNotes[0]?.id || null

        setNotes(cachedNotes)
        setActiveNoteId(cachedActiveId)
        updateSearchStatus(cachedNotes, false)
        startBackgroundSync(cachedNotes, cachedActiveId)
        hydratedFromCache = true
        setNotesLoading(false)
      }

      const latestRawNotes = await fetchSummaryListFromServer('active')
      const nextNotes = await materializeRawSummaryList('active', latestRawNotes)
      reconcileCachedNoteState(nextNotes)
      await hydrateCachedSearchIndex(nextNotes)
      const nextActiveId =
        activeNoteIdRef.current && nextNotes.some((note) => note.id === activeNoteIdRef.current)
          ? activeNoteIdRef.current
          : nextNotes[0]?.id || null

      setNotes(nextNotes)
      setActiveNoteId(nextActiveId)
      updateSearchStatus(nextNotes, false)
      startBackgroundSync(nextNotes, nextActiveId)
    } catch (error) {
      if (!hydratedFromCache) {
        toast.error(error.message || 'Failed to load notes')
      }
    } finally {
      setNotesLoading(false)
    }
  }, [
    fetchSummaryListFromServer,
    hydrateCachedSearchIndex,
    loadCachedSummaryList,
    materializeRawSummaryList,
    reconcileCachedNoteState,
    startBackgroundSync,
    updateSearchStatus,
  ])

  const fetchTrash = useCallback(async () => {
    setTrashLoading(true)
    let hydratedFromCache = false

    try {
      const cachedRawTrashNotes = await loadCachedSummaryList('trash')
      if (cachedRawTrashNotes) {
        const cachedTrashNotes = await materializeRawSummaryList('trash', cachedRawTrashNotes)
        trashLoadedRef.current = true
        setTrashNotes(cachedTrashNotes)
        setActiveTrashNoteId((prev) =>
          prev && cachedTrashNotes.some((note) => note.id === prev)
            ? prev
            : cachedTrashNotes[0]?.id || null
        )
        hydratedFromCache = true
        setTrashLoading(false)
      }

      const latestRawTrashNotes = await fetchSummaryListFromServer('trash')
      const nextTrashNotes = await materializeRawSummaryList('trash', latestRawTrashNotes)
      reconcileCachedNoteState(nextTrashNotes)
      trashLoadedRef.current = true
      setTrashNotes(nextTrashNotes)
      setActiveTrashNoteId((prev) =>
        prev && nextTrashNotes.some((note) => note.id === prev) ? prev : nextTrashNotes[0]?.id || null
      )
    } catch (error) {
      if (!hydratedFromCache) {
        toast.error(error.message || 'Failed to load trash')
      }
    } finally {
      setTrashLoading(false)
    }
  }, [
    fetchSummaryListFromServer,
    loadCachedSummaryList,
    materializeRawSummaryList,
    reconcileCachedNoteState,
  ])

  useEffect(() => {
    if (vaultLocked) {
      setNotes([])
      setActiveNoteId(null)
      setTrashNotes([])
      setTrashView(false)
      setActiveTrashNoteId(null)
      setActiveNoteContent(null)
      setActiveNoteContentId(null)
      setActiveTrashNoteContent(null)
      setActiveTrashNoteContentId(null)
      setActiveNoteLoading(false)
      setActiveTrashNoteLoading(false)
      clearSessionCaches()
      return
    }

    fetchNotes()

    return () => {
      cancelBackgroundSync()
    }
  }, [cancelBackgroundSync, clearSessionCaches, fetchNotes, vaultLocked])

  useEffect(() => {
    if (!editorShouldAutoFocus || !activeNoteId) {
      return
    }

    setEditorShouldAutoFocus(false)
  }, [activeNoteId, editorShouldAutoFocus])

  useEffect(() => {
    if (trashView || !activeNoteId || vaultLocked) {
      setActiveNoteContent(null)
      setActiveNoteContentId(null)
      setActiveNoteLoading(false)
      return
    }

    const requestedNoteId = String(activeNoteId)
    const cachedContent = decryptedBodyCacheRef.current.get(requestedNoteId)
    if (cachedContent) {
      setActiveNoteContent(cachedContent)
      setActiveNoteContentId(requestedNoteId)
      setActiveNoteLoading(false)
      return
    }

    const controller = new AbortController()
    setActiveNoteLoading(true)
    setActiveNoteContentId(null)

    ensureNoteBodyLoaded(requestedNoteId, {
      scope: 'active',
      signal: controller.signal,
      retainDecrypted: true,
    })
      .then((content) => {
        if (String(activeNoteIdRef.current) !== requestedNoteId) {
          return
        }
        setActiveNoteContent(content)
        setActiveNoteContentId(requestedNoteId)
        setActiveNoteLoading(false)
        updateSearchStatus(notesRef.current, searchStatus.running)
      })
      .catch((error) => {
        if (error?.name === 'AbortError') {
          return
        }

        if (String(activeNoteIdRef.current) !== requestedNoteId) {
          return
        }

        setActiveNoteLoading(false)
        toast.error(error.message || 'Failed to load note')
      })

    return () => controller.abort()
  }, [
    activeNoteId,
    ensureNoteBodyLoaded,
    searchStatus.running,
    trashView,
    updateSearchStatus,
    vaultLocked,
  ])

  useEffect(() => {
    if (!trashView || !activeTrashNoteId || vaultLocked) {
      setActiveTrashNoteContent(null)
      setActiveTrashNoteContentId(null)
      setActiveTrashNoteLoading(false)
      return
    }

    const requestedTrashNoteId = String(activeTrashNoteId)
    const cachedContent = decryptedBodyCacheRef.current.get(requestedTrashNoteId)
    if (cachedContent) {
      setActiveTrashNoteContent(cachedContent)
      setActiveTrashNoteContentId(requestedTrashNoteId)
      setActiveTrashNoteLoading(false)
      return
    }

    const controller = new AbortController()
    setActiveTrashNoteLoading(true)
    setActiveTrashNoteContentId(null)

    ensureNoteBodyLoaded(requestedTrashNoteId, {
      scope: 'trash',
      signal: controller.signal,
      retainDecrypted: true,
    })
      .then((content) => {
        if (String(activeTrashNoteIdRef.current) !== requestedTrashNoteId) {
          return
        }
        setActiveTrashNoteContent(content)
        setActiveTrashNoteContentId(requestedTrashNoteId)
        setActiveTrashNoteLoading(false)
      })
      .catch((error) => {
        if (error?.name === 'AbortError') {
          return
        }

        if (String(activeTrashNoteIdRef.current) !== requestedTrashNoteId) {
          return
        }

        setActiveTrashNoteLoading(false)
        toast.error(error.message || 'Failed to load note')
      })

    return () => controller.abort()
  }, [activeTrashNoteId, ensureNoteBodyLoaded, trashView, vaultLocked])

  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const visibleNotes = normalizedSearchQuery
    ? notes.filter((note) =>
        noteMatchesQuery(
          note,
          normalizedSearchQuery,
          noteSearchIndexRef.current.get(String(note.id))
        )
      )
    : notes

  arrowNavigationRef.current = (direction) => {
    if (trashView) {
      const nextTrashNoteId = getAdjacentNoteId(trashNotes, activeTrashNoteId, direction)

      if (!nextTrashNoteId) {
        return false
      }

      if (nextTrashNoteId !== activeTrashNoteId) {
        setActiveTrashNoteId(nextTrashNoteId)
      }

      return true
    }

    const nextNoteId = getAdjacentNoteId(visibleNotes, activeNoteId, direction)

    if (!nextNoteId) {
      return false
    }

    if (nextNoteId !== activeNoteId) {
      setEditorShouldAutoFocus(false)
      setActiveNoteId(nextNoteId)
    }

    return true
  }

  async function handleNewNote() {
    if (trashView) return

    try {
      const content = createEmptyNoteContent()
      const summary = createNoteSummary(content)
      const searchText = createNoteSearchText(content)
      let encryptedContent = null
      let encryptedSummary = null
      let data

      if (authMode === 'e2ee') {
        // Create the row first so the ciphertexts can be bound to the note id.
        const createRes = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({}),
        })
        const createData = await createRes.json()
        if (!createRes.ok) {
          throw new Error(createData?.error || 'Failed to create note')
        }

        const noteId = createData.note.id
        encryptedContent = await encryptNoteContent(content, noteId)
        encryptedSummary = await encryptNoteSummary(summary, noteId)

        const putRes = await fetch(`/api/notes/${noteId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ encryptedContent, encryptedSummary }),
        })
        data = await putRes.json()
        if (!putRes.ok) {
          throw new Error(data?.error || 'Failed to create note')
        }
      } else {
        const res = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ content }),
        })
        data = await res.json()
        if (!res.ok) {
          throw new Error(data?.error || 'Failed to create note')
        }
      }

      const nextNote =
        authMode === 'e2ee'
          ? applySummaryToNote(
              {
                ...data.note,
                encrypted_summary: encryptedSummary,
              },
              summary
            )
          : applySummaryToNote(data.note, createNoteSummary(content))

      setNotes((prev) => {
        const nextNotes = sortNotesByMostRecent([nextNote, ...prev])
        updateSearchStatus(nextNotes, searchStatus.running)
        return nextNotes
      })
      updateRawSummaryList('active', (prev) => [data.note, ...prev])

      if (authMode === 'e2ee') {
        const fullNoteRecord = {
          ...data.note,
          encrypted_content: encryptedContent,
          encrypted_summary: encryptedSummary,
        }
        fullNoteCacheRef.current.set(String(nextNote.id), fullNoteRecord)
        persistFullNoteRecord(fullNoteRecord)
      }

      noteSearchIndexRef.current.set(String(nextNote.id), searchText)
      indexedNoteIdsRef.current.add(String(nextNote.id))
      void persistSearchIndex(nextNote.id, nextNote.updated_at, searchText)
      noteBlobRefsRef.current.set(String(nextNote.id), extractBlobIdsFromContent(content))
      rememberDecryptedBody(nextNote.id, content)

      setActiveNoteContent(content)
      setEditorShouldAutoFocus(true)
      setActiveNoteId(nextNote.id)
      if (window.innerWidth <= 768) setSidebarOpen(false)
      toast.success('Note created')
    } catch (error) {
      toast.error(error.message || 'Failed to create note')
    }
  }

  newNoteRef.current = handleNewNote

  async function handleSoftDeleteNote(noteId) {
    try {
      const deletedNote = notesRef.current.find((note) => note.id === noteId)
      const res = await fetch(`/api/notes/${noteId}/trash`, {
        method: 'PUT',
        credentials: 'include',
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data?.error || 'Failed to delete note')
      }

      setNotes((prev) => {
        const filtered = prev.filter((note) => note.id !== noteId)
        updateSearchStatus(filtered, searchStatus.running)
        if (activeNoteId === noteId) {
          setEditorShouldAutoFocus(false)
          setActiveNoteId(filtered.length > 0 ? filtered[0].id : null)
          setActiveNoteContent(null)
        }
        return filtered
      })
      updateRawSummaryList('active', (prev) => prev.filter((note) => note.id !== noteId))
      if (deletedNote && rawSummaryListsRef.current.trash) {
        updateRawSummaryList('trash', (prev) => [
          {
            ...deletedNote,
            deleted_at: new Date().toISOString(),
          },
          ...prev.filter((note) => note.id !== noteId),
        ])
      }
      noteSearchIndexRef.current.delete(String(noteId))
      indexedNoteIdsRef.current.delete(String(noteId))
      toast.success('Note moved to trash')
    } catch (error) {
      toast.error(error.message || 'Failed to delete note')
    }
  }

  function handleDeleteActiveNote() {
    if (trashView || !activeNoteId) return
    handleSoftDeleteNote(activeNoteId)
  }

  deleteNoteRef.current = handleDeleteActiveNote

  async function handleRestoreNote(noteId) {
    try {
      const res = await fetch(`/api/notes/${noteId}/restore`, {
        method: 'PUT',
        credentials: 'include',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to restore note')

      const existingTrashNote = trashNotesRef.current.find((note) => note.id === noteId)
      const restoredSummary =
        authMode === 'e2ee'
          ? await decryptNoteSummary(data.note.encrypted_summary, data.note.id)
          : createNoteSummary(data.note.content || existingTrashNote?.content || createEmptyNoteContent())

      const restoredNote = applySummaryToNote(data.note, restoredSummary || existingTrashNote?.summary)

      const nextTrashNotes = trashNotesRef.current.filter((note) => note.id !== noteId)
      const nextActiveNotes = sortNotesByMostRecent([restoredNote, ...notesRef.current])

      setTrashNotes(nextTrashNotes)
      updateRawSummaryList('trash', (prev) => prev.filter((note) => note.id !== noteId))
      setNotes(nextActiveNotes)
      updateSearchStatus(nextActiveNotes, searchStatus.running)
      updateRawSummaryList('active', (prev) => [data.note, ...(prev || [])])

      if (String(activeTrashNoteId) === String(noteId)) {
        setActiveTrashNoteContent(null)
        setActiveTrashNoteId(nextTrashNotes[0]?.id || null)
      }

      if (authMode === 'e2ee') {
        startBackgroundSync(nextActiveNotes, restoredNote.id)
      }

      toast.success('Note restored')
    } catch (error) {
      toast.error(error.message || 'Failed to restore note')
    }
  }

  async function handlePermanentDelete(noteId) {
    try {
      const res = await fetch(`/api/notes/${noteId}`, {
        method: 'DELETE',
        credentials: 'include',
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data?.error || 'Failed to delete note')
      }

      if (authMode === 'e2ee' && canSafelyDeleteBlobs()) {
        const currentBlobIds = noteBlobRefsRef.current.get(String(noteId)) || new Set()
        const referencedBlobIds = collectReferencedBlobIds(noteId)
        const removableBlobIds = [...currentBlobIds].filter((blobId) => !referencedBlobIds.has(blobId))
        await Promise.all(removableBlobIds.map((blobId) => deleteBlob(blobId)))
      }

      const nextTrashNotes = trashNotesRef.current.filter((note) => note.id !== noteId)
      setTrashNotes(nextTrashNotes)
      updateRawSummaryList('trash', (prev) => prev.filter((note) => note.id !== noteId))
      noteBlobRefsRef.current.delete(String(noteId))
      noteSearchIndexRef.current.delete(String(noteId))
      indexedNoteIdsRef.current.delete(String(noteId))
      fullNoteCacheRef.current.delete(String(noteId))
      decryptedBodyCacheRef.current.delete(String(noteId))
      decryptedBodyOrderRef.current = decryptedBodyOrderRef.current.filter(
        (cachedId) => cachedId !== String(noteId)
      )

      if (String(activeTrashNoteId) === String(noteId)) {
        setActiveTrashNoteContent(null)
        setActiveTrashNoteId(nextTrashNotes[0]?.id || null)
      }

      deletePersistentNoteCaches(noteId)
      toast.success('Note permanently deleted')
    } catch (error) {
      toast.error(error.message || 'Failed to delete note')
    }
  }

  async function handleUpdateNote(noteId, content) {
    const previousContent =
      activeNoteId === noteId
        ? activeNoteContent
        : decryptedBodyCacheRef.current.get(String(noteId)) || createEmptyNoteContent()
    const previousBlobIds = extractBlobIdsFromContent(previousContent)

    try {
      const summary = createNoteSummary(content)
      const searchText = createNoteSearchText(content)
      const payload =
        authMode === 'e2ee'
          ? {
              encryptedContent: await encryptNoteContent(content, noteId),
              encryptedSummary: await encryptNoteSummary(summary, noteId),
            }
          : { content }

      const res = await fetch(`/api/notes/${noteId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to update note')
      }

      const nextNote =
        authMode === 'e2ee'
          ? applySummaryToNote(
              {
                ...data.note,
                encrypted_summary: payload.encryptedSummary,
              },
              summary
            )
          : applySummaryToNote(data.note, summary)

      setNotes((prev) => sortNotesByMostRecent(prev.map((note) => (note.id === noteId ? nextNote : note))))
      updateRawSummaryList('active', (prev) =>
        prev.map((note) => (note.id === noteId ? { ...note, ...data.note } : note))
      )

      if (authMode === 'e2ee') {
        const fullNoteRecord = {
          ...(fullNoteCacheRef.current.get(String(noteId)) || {}),
          ...data.note,
          encrypted_content: payload.encryptedContent,
          encrypted_summary: payload.encryptedSummary,
        }
        fullNoteCacheRef.current.set(String(noteId), fullNoteRecord)
        persistFullNoteRecord(fullNoteRecord)
      }

      noteSearchIndexRef.current.set(String(noteId), searchText)
      indexedNoteIdsRef.current.add(String(noteId))
      void persistSearchIndex(noteId, data.note.updated_at, searchText)
      noteBlobRefsRef.current.set(String(noteId), extractBlobIdsFromContent(content))
      rememberDecryptedBody(noteId, content)

      if (String(activeNoteId) === String(noteId)) {
        setActiveNoteContent(content)
      }

      if (authMode === 'e2ee' && canSafelyDeleteBlobs()) {
        const nextBlobIds = extractBlobIdsFromContent(content)
        const referencedBlobIds = collectReferencedBlobIds(noteId)
        const removedBlobIds = [...previousBlobIds].filter(
          (blobId) => !nextBlobIds.has(blobId) && !referencedBlobIds.has(blobId)
        )
        await Promise.all(removedBlobIds.map((blobId) => deleteBlob(blobId)))
      }
    } catch {
      // silent fail on auto-save
    }
  }

  async function handleUploadImage(file) {
    return uploadEncryptedBlob(file)
  }

  function handleOpenTrash() {
    setTrashView(true)
    setActiveNoteId(null)
    setActiveNoteContent(null)
    setActiveNoteContentId(null)
    setActiveTrashNoteId(null)
    fetchTrash()
  }

  function handleCloseTrash() {
    setTrashView(false)
    setActiveTrashNoteId(null)
    setActiveTrashNoteContent(null)
    setActiveTrashNoteContentId(null)
    const firstNote = notesRef.current[0]
    if (firstNote) setActiveNoteId(firstNote.id)
  }

  const activeNoteSummary = notes.find((note) => note.id === activeNoteId)
  const activeTrashNoteSummary = trashNotes.find((note) => note.id === activeTrashNoteId)
  const activeNoteHasMatchingContent =
    activeNoteContent && String(activeNoteContentId) === String(activeNoteId)
  const activeTrashNoteHasMatchingContent =
    activeTrashNoteContent && String(activeTrashNoteContentId) === String(activeTrashNoteId)
  const activeNote = activeNoteSummary
    && activeNoteHasMatchingContent
    ? {
        ...activeNoteSummary,
        content: activeNoteContent,
      }
    : null
  const activeTrashNote = activeTrashNoteSummary
    && activeTrashNoteHasMatchingContent
    ? {
        ...activeTrashNoteSummary,
        content: activeTrashNoteContent,
      }
    : null

  if (vaultLocked) {
    return <VaultUnlockScreen />
  }

  return (
    <div className={`dashboard ${sidebarOpen ? 'sidebar-visible' : ''}`}>
      <Header onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />

      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <NotesSidebar
          notes={visibleNotes}
          activeNoteId={activeNoteId}
          onSelectNote={(id) => {
            if (trashView) handleCloseTrash()
            setEditorShouldAutoFocus(false)
            setActiveNoteContent(null)
            setActiveNoteContentId(null)
            setActiveNoteLoading(true)
            setActiveNoteId(id)
            if (window.innerWidth <= 768) setSidebarOpen(false)
          }}
          onNewNote={handleNewNote}
          onDeleteNote={handleSoftDeleteNote}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          loading={notesLoading}
          trashView={trashView}
          trashNotes={trashNotes}
          trashLoading={trashLoading}
          onOpenTrash={handleOpenTrash}
          onCloseTrash={handleCloseTrash}
          onRestoreNote={handleRestoreNote}
          onPermanentDelete={handlePermanentDelete}
          onSelectTrashNote={(id) => {
            setActiveTrashNoteContent(null)
            setActiveTrashNoteContentId(null)
            setActiveTrashNoteLoading(true)
            setActiveTrashNoteId(id)
          }}
          activeTrashNoteId={activeTrashNoteId}
          searchStatus={searchStatus}
        />
      </aside>

      <main className="editor-area">
        {trashView ? (
          activeTrashNoteSummary ? (
            activeTrashNoteLoading || !activeTrashNote?.content ? (
              <div className="empty-state editor-loading-state">
                <div className="loader" />
                <p>Loading note...</p>
              </div>
            ) : (
              <Suspense fallback={null}>
                <NoteEditor
                  key={activeTrashNote.id}
                  note={activeTrashNote}
                  onUpdate={() => {}}
                  onUploadImage={handleUploadImage}
                  resolveImageSrc={resolveEncryptedBlobUrl}
                  readOnly
                />
              </Suspense>
            )
          ) : (
            <div className="empty-state">
              <FileText size={48} />
              <p>Select a note from the sidebar to preview</p>
            </div>
          )
        ) : notesLoading ? (
          <div className="empty-state">
            <div className="loader" />
          </div>
        ) : activeNoteSummary ? (
          activeNoteLoading || !activeNote?.content ? (
            <div className="empty-state editor-loading-state">
              <div className="loader" />
              <p>Loading note...</p>
            </div>
          ) : (
            <Suspense fallback={null}>
              <NoteEditor
                key={activeNote.id}
                note={activeNote}
                onUpdate={handleUpdateNote}
                onUploadImage={handleUploadImage}
                resolveImageSrc={resolveEncryptedBlobUrl}
                autoFocus={editorShouldAutoFocus}
              />
            </Suspense>
          )
        ) : (
          <div className="empty-state">
            <FileText size={48} />
            <p>Select a note or create a new one</p>
            <button className="btn-primary" onClick={handleNewNote}>
              New Note
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
