import { useState } from 'react'
import Modal from './Modal.jsx'
import { useAuth } from '../context/AuthContext.jsx'

export default function RecoveryKeyModal() {
  const { pendingRecoveryKey, dismissRecoveryKey } = useAuth()
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    if (!pendingRecoveryKey) {
      return
    }

    try {
      await navigator.clipboard.writeText(pendingRecoveryKey)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Modal isOpen={Boolean(pendingRecoveryKey)} onClose={dismissRecoveryKey}>
      <div className="recovery-modal">
        <h2>Recovery Key</h2>
        <p>
          Save this key now. It is the only way to regain access to encrypted notes if you forget
          your password.
        </p>
        <code className="recovery-key">{pendingRecoveryKey}</code>
        <div className="recovery-actions">
          <button className="btn-primary" type="button" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy Key'}
          </button>
          <button className="btn-ghost" type="button" onClick={dismissRecoveryKey}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}

