import { useState } from 'react'
import Modal from './Modal.jsx'

// A confirmation step for irreversible actions (DATA-9, SEC-6). With
// `requireText`, the user has to type it before the action is enabled.
export default function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  requireText,
  busy = false,
  onConfirm,
  onCancel,
  children,
}) {
  const [typed, setTyped] = useState('')
  const ready = !requireText || typed.trim() === requireText

  function close() {
    setTyped('')
    onCancel()
  }

  return (
    <Modal isOpen={isOpen} onClose={busy ? undefined : close} dismissible={!busy} labelledBy="confirm-dialog-title">
      <div className="confirm-dialog">
        <h2 id="confirm-dialog-title">{title}</h2>
        {message && <p>{message}</p>}
        {children}
        {requireText && (
          <div className="form-group">
            <label htmlFor="confirm-dialog-input">
              Type <strong>{requireText}</strong> to confirm
            </label>
            <input
              id="confirm-dialog-input"
              type="text"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
            />
          </div>
        )}
        <div className="confirm-actions">
          <button type="button" className="btn-ghost" onClick={close} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn-danger' : 'btn-primary'}
            disabled={!ready || busy}
            onClick={async () => {
              await onConfirm()
              setTyped('')
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
