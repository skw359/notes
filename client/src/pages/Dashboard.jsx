import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, FileText, History } from 'lucide-react'
import toast from 'react-hot-toast'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import ConflictBanner from '../components/ConflictBanner.jsx'
import EditorErrorBoundary from '../components/EditorErrorBoundary.jsx'
import Header from '../components/Header.jsx'
import HistoryModal from '../components/HistoryModal.jsx'
import NoteProblem from '../components/NoteProblem.jsx'
import NotesSidebar from '../components/NotesSidebar.jsx'
import SaveStatus from '../components/SaveStatus.jsx'
import SessionExpiredBanner from '../components/SessionExpiredBanner.jsx'
import VaultUnlockScreen from '../components/VaultUnlockScreen.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { uploadFile } from '../lib/attachments.js'
import { createE2EECodec, createLegacyCodec } from '../lib/noteCodecs.js'
import { createNoteStore } from '../lib/noteStore.js'

const NoteEditor = lazy(() => import('../components/NoteEditor.jsx'))

const EMPTY_SNAPSHOT = Object.freeze({
  status: 'idle',
  notes: [],
  trash: [],
  saveStates: {},
  attention: [],
  search: { running: false, indexed: 0, total: 0 },
  refs: {},
  sessionExpired: false,
})
const NULL_STORE = { subscribe: () => () => {}, getSnapshot: () => EMPTY_SNAPSHOT }
const SYNC_INTERVAL_MS = 60 * 1000
const MIN_SYNC_GAP_MS = 5 * 1000

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return (
    target.isContentEditable ||
    Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]'))
  )
}

function adjacentId(list, activeId, direction) {
  if (!list.length) {
    return null
  }
  const index = list.findIndex((note) => note.id === activeId)
  if (index === -1) {
    return direction > 0 ? list[0].id : list[list.length - 1].id
  }
  return list[Math.min(Math.max(index + direction, 0), list.length - 1)].id
}

export default function Dashboard() {
  const {
    api,
    authMode,
    vault,
    vaultLocked,
    user,
    session,
    profile,
    sessionExpired,
    attachments,
    registerLockHandler,
    registerResumeHandler,
    setUpgradeDeferred,
  } = useAuth()

  const [store, setStore] = useState(null)
  const snapshot = useSyncExternalStore((store || NULL_STORE).subscribe, (store || NULL_STORE).getSnapshot)
  const [activeId, setActiveId] = useState(null)
  const [trashView, setTrashView] = useState(false)
  const [activeTrashId, setActiveTrashId] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [loaded, setLoaded] = useState({ key: null, content: null, error: null, rollback: null, token: 0 })
  const [reloadToken, setReloadToken] = useState(0)
  const [autoFocus, setAutoFocus] = useState(false)
  // The open editor holds keystrokes that were not handed to the store yet.
  const [editorDirty, setEditorDirty] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [removedNotice, setRemovedNotice] = useState(null)
  const [limits, setLimits] = useState(null)

  const editorRef = useRef(null)
  const lastSyncRef = useRef(0)
  // The decrypted profile and the envelope it came from (set together).
  const profileIv = session?.encryptedProfile?.iv ?? null
  const profileRef = useRef({ profile, profileIv })
  const userId = user?.id

  useEffect(() => {
    profileRef.current = { profile, profileIv }
  }, [profile, profileIv])

  // One store per unlocked vault (or per legacy session).
  useEffect(() => {
    if (!userId || (authMode === 'e2ee' && !vault) || !authMode) {
      return undefined
    }
    const next = createNoteStore({
      api,
      codec: authMode === 'e2ee' ? createE2EECodec(vault) : createLegacyCodec(),
      userId,
      getProfileReference: () => {
        const { profile: current, profileIv: iv } = profileRef.current
        if (!current) {
          return undefined
        }
        return { blobId: current.profile_picture_blob_id ? Number(current.profile_picture_blob_id) : null, profileIv: iv }
      },
    })
    setStore(next)
    void next.start()
    return () => {
      next.stop()
      setStore(null)
    }
  }, [api, authMode, userId, vault])

  useEffect(() => {
    if (authMode !== 'e2ee' || !vault) {
      return
    }
    api
      .get('/api/blobs/usage')
      .then(setLimits)
      .catch(() => {})
  }, [api, authMode, vault])

  // Unsent edits are encrypted into the outbox before the vault locks; a
  // lock is refused rather than ever dropping typed text.
  useEffect(() => {
    if (!store) {
      return undefined
    }
    const offLock = registerLockHandler(async () => {
      editorRef.current?.flush()
      await store.flushAll()
      return !store.hasVolatileChanges()
    })
    const offResume = registerResumeHandler(() => store.resumeAfterAuth())
    return () => {
      offLock()
      offResume()
    }
  }, [registerLockHandler, registerResumeHandler, store])

  // Store events: remote edits, removals, rollbacks, missing attachments.
  useEffect(() => {
    if (!store) {
      return undefined
    }
    return store.onEvent((event) => {
      if (event.type === 'note-replaced') {
        setReloadToken((value) => value + 1)
        if (event.reason === 'remote') {
          toast('This note was updated on another device.', { icon: '🔄' })
        }
      } else if (event.type === 'note-removed' && event.reason === 'deleted') {
        setRemovedNotice(event.id)
      } else if (event.type === 'rollback') {
        toast.error('The server returned an older version of a note than this device has seen. Check its history.', {
          duration: 10000,
        })
      } else if (event.type === 'missing-attachments') {
        toast.error('Some attachments in this note are no longer available on the server.')
      } else if (event.type === 'key-rotated') {
        toast.error('Your encryption key changed on another device. Lock and unlock to continue saving.', {
          duration: 10000,
        })
      }
    })
  }, [store])

  // DATA-3: learn about edits made elsewhere when the tab comes back, on
  // focus and periodically while visible.
  useEffect(() => {
    if (!store) {
      return undefined
    }
    const syncSoon = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastSyncRef.current < MIN_SYNC_GAP_MS) {
        return
      }
      lastSyncRef.current = Date.now()
      void store.sync()
    }
    document.addEventListener('visibilitychange', syncSoon)
    window.addEventListener('focus', syncSoon)
    window.addEventListener('online', syncSoon)
    const timer = window.setInterval(syncSoon, SYNC_INTERVAL_MS)
    return () => {
      document.removeEventListener('visibilitychange', syncSoon)
      window.removeEventListener('focus', syncSoon)
      window.removeEventListener('online', syncSoon)
      window.clearInterval(timer)
    }
  }, [store])

  // DATA-2: closing the tab with unsent changes asks first.
  useEffect(() => {
    if (!store) {
      return undefined
    }
    const handleBeforeUnload = (event) => {
      editorRef.current?.flush()
      if (store.hasUnsavedChanges()) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [store])

  // The selection falls back to the newest note when the chosen one leaves
  // the list (trashed or deleted elsewhere), derived rather than stored.
  const activeStillListed =
    activeId != null && (snapshot.notes.some((note) => note.id === activeId) || removedNotice === activeId)
  const currentId = activeStillListed ? activeId : snapshot.status === 'ready' ? (snapshot.notes[0]?.id ?? null) : null
  const openId = trashView ? activeTrashId : currentId
  const requestKey = openId == null ? null : `${trashView ? 'trash' : 'note'}:${openId}:${reloadToken}`

  // Load the open note's body.
  useEffect(() => {
    if (!store || openId == null) {
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    store
      .openNote(openId, { signal: controller.signal })
      .then((result) => {
        if (!cancelled) {
          setLoaded({ key: requestKey, content: result.content, error: null, rollback: result.rollback, token: Date.now() })
        }
      })
      .catch((error) => {
        if (!cancelled && error?.name !== 'AbortError') {
          setLoaded({ key: requestKey, content: null, error, rollback: null, token: Date.now() })
        }
      })
    return () => {
      cancelled = true
      controller.abort()
      store.closeNote(openId)
    }
  }, [openId, requestKey, store])

  const selectNote = useCallback(
    (id) => {
      editorRef.current?.flush()
      if (trashView) {
        setTrashView(false)
      }
      setRemovedNotice(null)
      setAutoFocus(false)
      setActiveId(id)
      if (window.innerWidth <= 768) setSidebarOpen(false)
    },
    [trashView]
  )

  const handleNewNote = useCallback(async () => {
    if (!store) return
    editorRef.current?.flush()
    try {
      const note = await store.createNote()
      setTrashView(false)
      setAutoFocus(true)
      setActiveId(note.id)
      if (window.innerWidth <= 768) setSidebarOpen(false)
    } catch (error) {
      toast.error(error.message || 'Failed to create note')
    }
  }, [store])

  const handleTrash = useCallback(
    async (id) => {
      if (!store) return
      if (id === currentId) {
        editorRef.current?.flush()
      }
      try {
        await store.trashNote(id)
        toast(
          (t) => (
            <span className="toast-with-action">
              Moved to trash
              <button
                type="button"
                className="btn-link"
                onClick={async () => {
                  toast.dismiss(t.id)
                  await store.restoreNote(id)
                  setActiveId(id)
                }}
              >
                Undo
              </button>
            </span>
          ),
          { duration: 6000 }
        )
      } catch (error) {
        toast.error(error.message || 'Failed to move the note to the trash')
      }
    },
    [currentId, store]
  )

  const handleRestore = useCallback(
    async (id) => {
      try {
        await store.restoreNote(id)
        toast.success('Note restored')
        if (activeTrashId === id) {
          setActiveTrashId(null)
        }
      } catch (error) {
        toast.error(error.message || 'Failed to restore note')
      }
    },
    [activeTrashId, store]
  )

  async function confirmPermanentDelete() {
    const id = pendingDelete
    try {
      await store.deleteNotePermanently(id)
      toast.success('Note permanently deleted')
      if (activeTrashId === id) {
        setActiveTrashId(null)
      }
    } catch (error) {
      toast.error(error.message || 'Failed to delete note')
    } finally {
      setPendingDelete(null)
    }
  }

  const visibleNotes = useMemo(() => {
    if (!store || !searchQuery.trim()) {
      return snapshot.notes
    }
    return store.searchMatches(searchQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, searchQuery, snapshot.notes, snapshot.search.indexed])

  // Keyboard: Ctrl/Cmd+J new note, Ctrl/Cmd+D trash (DATA-9: never while
  // typing, so it no longer hijacks the editor or the bookmark shortcut).
  const keyboardRef = useRef(null)
  const handleKeyDown = (event) => {
    const mod = event.metaKey || event.ctrlKey
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'j') {
      event.preventDefault()
      void handleNewNote()
      return
    }
    if (document.querySelector('.modal-overlay') || isEditableTarget(event.target)) {
      return
    }
    if (mod && event.key.toLowerCase() === 'd' && !trashView && currentId != null) {
      event.preventDefault()
      void handleTrash(currentId)
      return
    }
    if (event.altKey || mod || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      return
    }
    const direction = event.key === 'ArrowDown' ? 1 : -1
    if (trashView) {
      const next = adjacentId(snapshot.trash, activeTrashId, direction)
      if (next != null) setActiveTrashId(next)
    } else {
      const next = adjacentId(visibleNotes, currentId, direction)
      if (next != null) selectNote(next)
    }
    event.preventDefault()
  }
  useEffect(() => {
    keyboardRef.current = handleKeyDown
  })
  useEffect(() => {
    const handler = (event) => keyboardRef.current?.(event)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const uploadForEditor = useCallback(
    (file) => {
      if (!vault) {
        return Promise.reject(new Error('Upgrade to encrypted storage to add attachments'))
      }
      return uploadFile({ api, vault, file })
    },
    [api, vault]
  )

  const handleChange = useCallback(
    (json) => {
      if (store && currentId != null) {
        store.updateNote(currentId, json)
      }
    },
    [currentId, store]
  )

  const openAttachment = useCallback(
    (reference) => {
      attachments.download(reference).catch((error) => toast.error(`Could not open the attachment: ${error.message}`))
    },
    [attachments]
  )

  if (vaultLocked) {
    return <VaultUnlockScreen />
  }

  const activeRecord = snapshot.notes.find((note) => note.id === currentId) || (store && currentId != null ? store.getNoteRecord(currentId) : null)
  const saveState = currentId != null ? snapshot.saveStates[currentId] : null
  const conflict = saveState?.state === 'conflict' ? saveState.conflict : null
  const attention = snapshot.attention.filter((id) => id !== currentId)
  const ready = loaded.key === requestKey && (loaded.content || loaded.error)
  const legacy = authMode === 'legacy'

  return (
    <div className={`dashboard ${sidebarOpen ? 'sidebar-visible' : ''}`}>
      <Header onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />

      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <NotesSidebar
          notes={visibleNotes}
          activeNoteId={currentId}
          onSelectNote={selectNote}
          onNewNote={handleNewNote}
          onDeleteNote={handleTrash}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          loading={snapshot.status === 'loading' || snapshot.status === 'idle'}
          trashView={trashView}
          trashNotes={snapshot.trash}
          trashLoading={trashView && !snapshot.trashLoaded}
          onOpenTrash={() => {
            editorRef.current?.flush()
            setTrashView(true)
            setActiveTrashId(null)
            store?.loadTrash().catch((error) => toast.error(error.message || 'Failed to load trash'))
          }}
          onCloseTrash={() => setTrashView(false)}
          onRestoreNote={handleRestore}
          onPermanentDelete={(id) => setPendingDelete(id)}
          onSelectTrashNote={setActiveTrashId}
          activeTrashNoteId={activeTrashId}
          searchStatus={snapshot.search}
          saveStates={snapshot.saveStates}
        />
      </aside>

      <main className="editor-area">
        {sessionExpired && <SessionExpiredBanner />}
        {snapshot.error && snapshot.status === 'ready' && (
          <div className="banner banner-warn" role="status">
            <AlertTriangle size={16} />
            <div className="banner-body">
              <strong>Showing notes saved on this device.</strong>
              <span>The server could not be reached: {snapshot.error}</span>
            </div>
          </div>
        )}
        {legacy && (
          <div className="banner banner-warn">
            <AlertTriangle size={16} />
            <div className="banner-body">
              <strong>Your notes are not end-to-end encrypted yet.</strong>
              <div className="banner-actions">
                <button type="button" className="btn-primary" onClick={() => setUpgradeDeferred(false)}>
                  Upgrade now
                </button>
              </div>
            </div>
          </div>
        )}
        {attention.length > 0 && (
          <div className="banner banner-warn">
            <AlertTriangle size={16} />
            <div className="banner-body">
              <strong>
                {attention.length === 1 ? 'A note has' : `${attention.length} notes have`} unsaved changes that need your
                decision.
              </strong>
              <div className="banner-actions">
                <button type="button" className="btn-link" onClick={() => selectNote(attention[0])}>
                  Review
                </button>
              </div>
            </div>
          </div>
        )}

        {trashView ? (
          activeTrashId == null ? (
            <div className="empty-state">
              <FileText size={48} />
              <p>Select a note from the trash to preview it</p>
            </div>
          ) : !ready ? (
            <div className="empty-state editor-loading-state">
              <div className="loader" />
              <p>Loading note...</p>
            </div>
          ) : loaded.error ? (
            <NoteProblem diagnostic={loaded.error.diagnostic || { message: loaded.error.message }} />
          ) : (
            <>
              <div className="editor-meta">
                <span>In the trash. Restore it to edit.</span>
                <button type="button" className="btn-ghost" onClick={() => handleRestore(activeTrashId)}>
                  Restore
                </button>
              </div>
              <Suspense fallback={null}>
                <NoteEditor
                  key={`trash:${activeTrashId}:${loaded.token}`}
                  note={{ content: loaded.content }}
                  resolveImageSrc={attachments.resolve}
                  onOpenAttachment={openAttachment}
                  readOnly
                />
              </Suspense>
            </>
          )
        ) : snapshot.status !== 'ready' && !snapshot.notes.length ? (
          <div className="empty-state">
            {snapshot.status === 'error' ? (
              <>
                <AlertTriangle size={40} />
                <p>{snapshot.error || 'Failed to load notes'}</p>
                <button type="button" className="btn-primary" onClick={() => store?.start()}>
                  Try again
                </button>
              </>
            ) : (
              <div className="loader" />
            )}
          </div>
        ) : currentId != null && (activeRecord || removedNotice === currentId) ? (
          !ready ? (
            <div className="empty-state editor-loading-state">
              <div className="loader" />
              <p>Loading note...</p>
            </div>
          ) : loaded.error ? (
            <NoteProblem
              diagnostic={loaded.error.diagnostic || { message: loaded.error.message }}
              onShowHistory={() => setHistoryOpen(true)}
              onTrash={() => handleTrash(currentId)}
            />
          ) : (
            <>
              {removedNotice === currentId && (
                <div className="banner banner-error" role="alert">
                  <AlertTriangle size={16} />
                  <div className="banner-body">
                    <strong>This note was deleted on another device.</strong>
                    <div className="banner-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={async () => {
                          editorRef.current?.flush()
                          const content = loaded.content
                          const note = await store.createNote({ content })
                          setRemovedNotice(null)
                          setActiveId(note.id)
                        }}
                      >
                        Keep a copy as a new note
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {conflict && (
                <ConflictBanner
                  conflict={conflict}
                  onShowHistory={() => setHistoryOpen(true)}
                  onResolve={async (choice) => {
                    editorRef.current?.flush()
                    try {
                      const created = await store.resolveConflict(currentId, choice)
                      if (created) {
                        toast.success('Your version was saved as a new note')
                      }
                    } catch (error) {
                      toast.error(error.message)
                    }
                  }}
                />
              )}
              {loaded.rollback && (
                <div className="banner banner-warn" role="alert">
                  <AlertTriangle size={16} />
                  <div className="banner-body">
                    <strong>The server returned an older version of this note than this device has seen.</strong>
                    <span>
                      Revision {loaded.rollback.served} was served after revision {loaded.rollback.seen}. Check the
                      history before editing.
                    </span>
                  </div>
                </div>
              )}
              <div className="editor-meta">
                <SaveStatus
                  state={editorDirty && (!saveState || saveState.state === 'saved') ? 'pending' : saveState?.state || 'saved'}
                  error={saveState?.error}
                  onRetry={() => store.retry(currentId)}
                />
                {!legacy && (
                  <button type="button" className="btn-ghost" onClick={() => setHistoryOpen(true)} title="Version history">
                    <History size={16} /> History
                  </button>
                )}
              </div>
              <EditorErrorBoundary key={`${currentId}:${loaded.token}`}>
                <Suspense fallback={null}>
                  <NoteEditor
                    ref={editorRef}
                    note={{ content: loaded.content }}
                    onChange={handleChange}
                    onDirtyChange={setEditorDirty}
                    onUploadFile={uploadForEditor}
                    resolveImageSrc={attachments.resolve}
                    onOpenAttachment={openAttachment}
                    maxUploadBytes={limits?.maxBlobBytes}
                    autoFocus={autoFocus}
                  />
                </Suspense>
              </EditorErrorBoundary>
            </>
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

      {store && !legacy && (
        <HistoryModal
          isOpen={historyOpen}
          noteId={currentId}
          store={store}
          resolveImageSrc={attachments.resolve}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      <ConfirmDialog
        isOpen={pendingDelete != null}
        title="Delete permanently?"
        message="This note and its history will be deleted from the server. This cannot be undone."
        confirmLabel="Delete permanently"
        danger
        onConfirm={confirmPermanentDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
