import { AlertTriangle, Check, CloudOff, Loader2, Lock, RefreshCw } from 'lucide-react'

const LABELS = {
  saved: { icon: Check, text: 'Saved', tone: 'ok' },
  pending: { icon: Loader2, text: 'Saving…', tone: 'busy' },
  saving: { icon: Loader2, text: 'Saving…', tone: 'busy' },
  retrying: { icon: RefreshCw, text: 'Retrying…', tone: 'warn' },
  offline: { icon: CloudOff, text: 'Offline: saved on this device', tone: 'warn' },
  auth: { icon: Lock, text: 'Sign in again to save', tone: 'error' },
  conflict: { icon: AlertTriangle, text: 'Changed elsewhere: choose a version', tone: 'error' },
  failed: { icon: AlertTriangle, text: 'Not saved', tone: 'error' },
}

// DATA-2: the user always sees whether the open note is safely on the server.
export default function SaveStatus({ state = 'saved', error, onRetry }) {
  const entry = LABELS[state] || LABELS.saved
  const Icon = entry.icon
  return (
    <div className={`save-status save-status-${entry.tone}`} role="status" aria-live="polite" title={error || entry.text}>
      <Icon size={14} className={entry.tone === 'busy' ? 'spin' : undefined} />
      <span>{entry.text}</span>
      {state === 'failed' && onRetry && (
        <button type="button" className="btn-link" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}
