import { useEffect, useRef } from 'react'
import { AlertTriangle, ArrowLeft, Plus, RotateCcw, Search, ShieldAlert, Trash2, X } from 'lucide-react'

// DATA-8: an undecryptable note is listed as such instead of hiding the list.
function getNoteTitle(note) {
  if (note.decryptError && !note.summary?.title) {
    return "Can't decrypt this note"
  }
  return note.summary?.title || 'Untitled'
}

function getNotePreview(note) {
  if (note.decryptError) {
    return `Error: ${note.decryptError.code}`
  }
  return note.summary?.preview || ''
}

function NoteBadges({ note, saveState }) {
  const unsent = saveState && ['pending', 'saving', 'retrying', 'offline', 'auth'].includes(saveState.state)
  const needsDecision = note.has_conflict || saveState?.state === 'conflict' || saveState?.state === 'failed'
  return (
    <>
      {note.decryptError && <ShieldAlert size={13} className="note-badge note-badge-error" aria-label="Cannot decrypt" />}
      {needsDecision && (
        <AlertTriangle size={13} className="note-badge note-badge-warn" aria-label="Has conflicting edits" />
      )}
      {unsent && <span className="note-badge-dot" title="Not yet saved to the server" />}
    </>
  )
}

function formatDate(dateStr) {
  const date = new Date(dateStr)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function daysUntilDeletion(deletedAt) {
  const deleted = new Date(deletedAt)
  const expiry = new Date(deleted.getTime() + 30 * 24 * 60 * 60 * 1000)
  const now = new Date()
  const days = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
  return Math.max(0, days)
}

export default function NotesSidebar({
  notes,
  activeNoteId,
  onSelectNote,
  onNewNote,
  onDeleteNote,
  searchQuery,
  setSearchQuery,
  loading,
  trashView,
  trashNotes,
  trashLoading,
  onOpenTrash,
  onCloseTrash,
  onRestoreNote,
  onPermanentDelete,
  onSelectTrashNote,
  activeTrashNoteId,
  searchStatus,
  saveStates = {},
}) {
  const listRef = useRef(null)
  const selectedNoteId = trashView ? activeTrashNoteId : activeNoteId

  useEffect(() => {
    if (!selectedNoteId || !listRef.current) {
      return
    }

    const activeItem = listRef.current.querySelector(`[data-note-id="${selectedNoteId}"]`)
    activeItem?.scrollIntoView({ block: 'nearest' })
  }, [activeNoteId, activeTrashNoteId, notes, trashNotes, selectedNoteId])

  if (trashView) {
    return (
      <div className="sidebar-inner">
        <div className="sidebar-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn-ghost" onClick={onCloseTrash} title="Back to notes" style={{ padding: 4 }}>
              <ArrowLeft size={16} />
            </button>
            <h2>Recently Deleted</h2>
          </div>
        </div>
        <div className="notes-list" ref={listRef}>
          {trashNotes.map((note) => (
            <div
              key={note.id}
              data-note-id={note.id}
              className={`note-item ${note.id === activeTrashNoteId ? 'active' : ''}`}
              onClick={() => onSelectTrashNote(note.id)}
            >
              <div className="note-item-title">{getNoteTitle(note)}</div>
              {getNotePreview(note) && <div className="note-item-preview">{getNotePreview(note)}</div>}
              <div className="note-item-date">{daysUntilDeletion(note.deleted_at)} days remaining</div>
              <div className="trash-item-actions">
                <button
                  className="btn-ghost"
                  style={{ padding: 4 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRestoreNote(note.id)
                  }}
                  title="Restore note"
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  className="btn-ghost trash-delete-btn"
                  style={{ padding: 4 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onPermanentDelete(note.id)
                  }}
                  title="Delete permanently"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
          {trashNotes.length === 0 && (
            <div style={{ padding: 16, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              {trashLoading ? (
                <div className="loader" />
              ) : (
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center', margin: 0 }}>
                  Trash is empty
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="sidebar-inner">
      <div className="sidebar-header">
        <h2>My Notes</h2>
        <button className="btn-ghost" onClick={onNewNote} title="New Note">
          <Plus size={18} />
        </button>
      </div>
      <div className="sidebar-search">
        <Search size={14} />
        <input
          type="text"
          placeholder="Search notes..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      {searchStatus?.running && searchStatus?.totalCount > 0 && (
        <div className="sidebar-search-status">
          {`Indexing ${searchStatus.indexedCount}/${searchStatus.totalCount} note bodies`}
        </div>
      )}
      <div className="notes-list" ref={listRef}>
        {notes.map((note) => (
          <div
            key={note.id}
            data-note-id={note.id}
            className={`note-item ${note.id === activeNoteId ? 'active' : ''}`}
            onClick={() => onSelectNote(note.id)}
          >
            <div className="note-item-header">
              <div className="note-item-title">
                {getNoteTitle(note)}
                <NoteBadges note={note} saveState={saveStates[note.id]} />
              </div>
              <button
                className="btn-ghost"
                style={{ padding: 4, flexShrink: 0 }}
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteNote(note.id)
                }}
                title="Delete note"
              >
                <Trash2 size={14} />
              </button>
            </div>
            {getNotePreview(note) && <div className="note-item-preview">{getNotePreview(note)}</div>}
            <div className="note-item-date">{formatDate(note.updated_at)}</div>
          </div>
        ))}
        {notes.length === 0 && (
          <div style={{ padding: 16, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            {loading ? (
              <div className="loader" />
            ) : (
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center', margin: 0 }}>
                {searchQuery.trim() ? 'No matching notes' : 'No notes yet'}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="sidebar-footer">
        <button className="btn-ghost sidebar-trash-btn" onClick={onOpenTrash} title="Recently Deleted">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  )
}
