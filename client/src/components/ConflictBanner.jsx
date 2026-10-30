import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

const MESSAGES = {
  REVISION_CONFLICT: 'This note was changed on another device while you were editing it.',
  CLIENT_OUTDATED: 'This note was changed elsewhere and your version was not saved.',
  NOTE_TRASHED: 'This note was moved to the trash on another device.',
  NOTE_DELETED: 'This note was permanently deleted on another device.',
  NOTE_NOT_FOUND: 'This note no longer exists.',
}

// DATA-3: a conflicting save is never applied or dropped silently. Both
// versions stay in the note's history whatever is chosen here.
export default function ConflictBanner({ conflict, onResolve, onShowHistory }) {
  const [busy, setBusy] = useState(false)
  const deleted = conflict.code === 'NOTE_DELETED' || conflict.code === 'NOTE_NOT_FOUND'
  const trashed = conflict.code === 'NOTE_TRASHED'

  async function choose(choice) {
    setBusy(true)
    try {
      await onResolve(choice)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="banner banner-error" role="alert">
      <AlertTriangle size={16} />
      <div className="banner-body">
        <strong>{MESSAGES[conflict.code] || conflict.message}</strong>
        <span>Your version is shown below and has not been lost.</span>
        <div className="banner-actions">
          {!deleted && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => choose('mine')}>
              {trashed ? 'Restore and keep my version' : 'Keep my version'}
            </button>
          )}
          {!deleted && !trashed && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => choose('theirs')}>
              Use the other version
            </button>
          )}
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => choose('copy')}>
            {deleted || trashed ? 'Save my version as a new note' : 'Keep both'}
          </button>
          {!deleted && onShowHistory && (
            <button type="button" className="btn-link" onClick={onShowHistory}>
              Compare in history
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
