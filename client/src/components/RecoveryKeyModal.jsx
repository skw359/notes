import { useState } from 'react'
import { Copy, Download } from 'lucide-react'
import Modal from './Modal.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { formatRecoveryKey } from '../lib/envelope.js'

const PURPOSE_TEXT = {
  signup: 'Your account is ready.',
  migration: 'Your account is about to be upgraded to end-to-end encryption.',
  recovery: 'Your password is about to be reset, and the recovery key you used will be replaced.',
  regenerate: 'Your old recovery key will stop working once you confirm.',
  rotation: 'Your encryption key is about to be replaced; old recovery keys will stop working.',
}

// CRYPTO-4: the key cannot be dismissed by a stray click or Escape. The user
// confirms they saved it by re-typing its last four characters. For flows
// that commit only after this confirmation (migration, recovery,
// regeneration, rotation) "Cancel" aborts without changing anything.
export default function RecoveryKeyModal() {
  const { recoveryPrompt } = useAuth()
  const [saved, setSaved] = useState(false)
  const [tail, setTail] = useState('')
  const [copied, setCopied] = useState(false)

  const key = recoveryPrompt?.key || ''
  const formatted = formatRecoveryKey(key)
  const expectedTail = key.slice(-4)
  const ready = saved && tail.trim() === expectedTail

  function reset() {
    setSaved(false)
    setTail('')
    setCopied(false)
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatted)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  function handleDownload() {
    const text = `Notes recovery key\n\n${formatted}\n\nKeep this somewhere safe and offline. Anyone with this key and your email can reset your password.\n`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'notes-recovery-key.txt'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <Modal isOpen={Boolean(recoveryPrompt)} dismissible={false} labelledBy="recovery-key-title">
      <div className="recovery-modal">
        <h2 id="recovery-key-title">Save your recovery key</h2>
        <p>{PURPOSE_TEXT[recoveryPrompt?.purpose] || ''}</p>
        <p>
          This key is the only way back into your encrypted notes if you forget your password. It will
          not be shown again.
        </p>
        <code className="recovery-key" data-testid="recovery-key">
          {formatted}
        </code>
        <div className="recovery-actions">
          <button className="btn-ghost" type="button" onClick={handleCopy}>
            <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn-ghost" type="button" onClick={handleDownload}>
            <Download size={14} /> Download
          </button>
        </div>

        <label className="checkbox-row">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I saved this recovery key somewhere safe
        </label>
        <div className="form-group">
          <label htmlFor="recovery-key-tail">Type the last 4 characters of the key</label>
          <input
            id="recovery-key-tail"
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={4}
            value={tail}
            onChange={(e) => setTail(e.target.value)}
          />
        </div>

        <div className="recovery-actions">
          {recoveryPrompt?.cancellable && (
            <button
              className="btn-ghost"
              type="button"
              onClick={() => {
                reset()
                recoveryPrompt.cancel()
              }}
            >
              Cancel
            </button>
          )}
          <button
            className="btn-primary"
            type="button"
            disabled={!ready}
            onClick={() => {
              reset()
              recoveryPrompt.confirm()
            }}
          >
            I saved it, continue
          </button>
        </div>
      </div>
    </Modal>
  )
}
