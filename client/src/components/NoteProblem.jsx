import { ShieldAlert } from 'lucide-react'

// DATA-8: a note that cannot be decrypted is shown as such, with enough
// detail to diagnose it, instead of breaking the whole list.
export default function NoteProblem({ diagnostic, onShowHistory, onTrash }) {
  return (
    <div className="empty-state note-problem">
      <ShieldAlert size={40} />
      <h2>This note can't be decrypted</h2>
      <p>{diagnostic?.message || 'The encrypted data is damaged or was encrypted with another key.'}</p>
      <dl className="diagnostics">
        <dt>Error</dt>
        <dd>{diagnostic?.code || 'DECRYPT_FAILED'}</dd>
        {diagnostic?.envelopeVersion != null && (
          <>
            <dt>Format</dt>
            <dd>v{diagnostic.envelopeVersion}</dd>
          </>
        )}
        {diagnostic?.context && (
          <>
            <dt>Bound to</dt>
            <dd>{diagnostic.context}</dd>
          </>
        )}
        {diagnostic?.keyId && (
          <>
            <dt>Key</dt>
            <dd>{diagnostic.keyId}</dd>
          </>
        )}
      </dl>
      <div className="confirm-actions">
        {onShowHistory && (
          <button type="button" className="btn-primary" onClick={onShowHistory}>
            Look for an earlier version
          </button>
        )}
        {onTrash && (
          <button type="button" className="btn-ghost" onClick={onTrash}>
            Move to trash
          </button>
        )}
      </div>
    </div>
  )
}
