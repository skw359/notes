import { lazy, Suspense, useEffect, useState } from 'react'
import { History, X } from 'lucide-react'
import toast from 'react-hot-toast'
import Modal from './Modal.jsx'

const NoteEditor = lazy(() => import('./NoteEditor.jsx'))

const REASONS = {
  interval: 'Earlier version',
  'device-switch': 'Before an edit from another device',
  restore: 'Before restoring an older version',
  'conflict-resolution': 'Before resolving a conflict',
  import: 'Before an import',
  'stale-revision': 'Edit that conflicted with a newer version',
  'missing-revision': 'Edit from an outdated app version',
  trashed: 'Edit made after the note was trashed elsewhere',
  'key-rotated': 'Edit made with a retired key',
  'outdated-format': 'Edit from an outdated app version',
}

function describe(revision) {
  return REASONS[revision.reason] || (revision.kind === 'conflict' ? 'Conflicting edit' : 'Earlier version')
}

// Mounted per note and per opening, so its state always starts fresh.
function HistoryContent({ noteId, store, resolveImageSrc, onClose, onRestored }) {
  const [revisions, setRevisions] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    store
      .listRevisions(noteId)
      .then((list) => {
        if (!cancelled) setRevisions(list)
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message)
      })
    return () => {
      cancelled = true
    }
  }, [noteId, store])

  useEffect(() => {
    if (!selected) {
      return undefined
    }
    let cancelled = false
    store
      .loadRevision(noteId, selected.id)
      .then((loaded) => {
        if (!cancelled) setPreview({ ...loaded, revisionId: selected.id })
      })
      .catch((loadError) => {
        if (!cancelled) setPreview({ revisionId: selected.id, error: loadError.message })
      })
    return () => {
      cancelled = true
    }
  }, [noteId, selected, store])

  const current = selected && preview?.revisionId === selected.id ? preview : null

  async function restore() {
    setBusy(true)
    try {
      await store.restoreRevision(noteId, selected.id)
      toast.success('Version restored. The previous one is kept in history.')
      onRestored?.()
      onClose()
    } catch (restoreError) {
      toast.error(restoreError.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="history-header">
        <h2 id="history-title">
          <History size={18} /> Version history
        </h2>
        <button type="button" className="btn-ghost" onClick={onClose} aria-label="Close history">
          <X size={18} />
        </button>
      </div>
      <div className="history-body">
        <ul className="history-list">
          {error && <li className="history-empty">{error}</li>}
          {!error && !revisions && <li className="history-empty">Loading…</li>}
          {revisions?.length === 0 && <li className="history-empty">No earlier versions yet.</li>}
          {revisions?.map((revision) => (
            <li key={revision.id}>
              <button
                type="button"
                className={`history-item ${selected?.id === revision.id ? 'active' : ''} ${revision.kind}`}
                onClick={() => setSelected(revision)}
              >
                <span className="history-date">{new Date(revision.created_at).toLocaleString()}</span>
                <span className="history-reason">
                  {describe(revision)}
                  {revision.kind === 'conflict' && !revision.resolved_at ? ' · unresolved' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="history-preview">
          {!selected && <p className="history-empty">Select a version to preview it.</p>}
          {selected && !current && <p className="history-empty">Decrypting…</p>}
          {current?.error && <p className="history-empty">This version could not be decrypted: {current.error}</p>}
          {current?.content && (
            <>
              <div className="history-preview-editor">
                <Suspense fallback={null}>
                  <NoteEditor
                    key={selected.id}
                    note={{ content: current.content }}
                    resolveImageSrc={resolveImageSrc}
                    readOnly
                  />
                </Suspense>
              </div>
              <div className="confirm-actions">
                <button type="button" className="btn-primary" disabled={busy} onClick={restore}>
                  {busy ? 'Restoring…' : 'Restore this version'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

// DATA-1 / DATA-3: every earlier version and every rejected edit kept by the
// server can be previewed and restored.
export default function HistoryModal({ isOpen, noteId, store, resolveImageSrc, onClose, onRestored }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} contentClassName="history-modal" labelledBy="history-title">
      {noteId != null && (
        <HistoryContent
          key={noteId}
          noteId={noteId}
          store={store}
          resolveImageSrc={resolveImageSrc}
          onClose={onClose}
          onRestored={onRestored}
        />
      )}
    </Modal>
  )
}
