import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../../context/AuthContext.jsx'
import { MIN_PASSWORD_LENGTH } from '../../lib/envelope.js'
import { rescueLegacyAttachments, scanLegacyAttachments } from '../../lib/legacyRescue.js'

function progressText(progress) {
  if (!progress) return ''
  const phase = { notes: 'Notes', history: 'History', scan: 'Scanning notes', finalize: 'Finishing' }[progress.phase] || 'Working'
  return progress.total ? `${phase}: ${progress.done}/${progress.total}` : `${phase}…`
}

function pendingTotal(pending) {
  return pending ? pending.notes + pending.revisions + pending.blobs + (pending.profile ? 1 : 0) : 0
}

export default function EncryptionSection() {
  const { api, vault, upgradeEncryption, rotateKey } = useAuth()
  const [status, setStatus] = useState(null)
  const [progress, setProgress] = useState(null)
  const [busy, setBusy] = useState(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [scan, setScan] = useState(null)

  const load = useCallback(() => {
    api
      .get('/api/vault/status')
      .then(setStatus)
      .catch((error) => toast.error(error.message))
  }, [api])

  useEffect(load, [load])

  async function run(name, task) {
    setBusy(name)
    setProgress(null)
    try {
      const result = await task()
      if (result?.complete === false) {
        toast.error(`Some items could not be re-encrypted yet (${pendingTotal(result.pending)} left). Run it again to continue.`)
      }
      return result
    } catch (error) {
      toast.error(error.message)
      return null
    } finally {
      setBusy(null)
      setProgress(null)
      load()
    }
  }

  async function handleUpgrade() {
    const result = await run('upgrade', () => upgradeEncryption(setProgress))
    if (result?.complete) {
      toast.success('Everything is now in the current encryption format.')
    }
  }

  async function handleRotate(event) {
    event.preventDefault()
    const result = await run('rotate', () => rotateKey({ currentPassword, newPassword }, setProgress))
    if (result?.complete) {
      setCurrentPassword('')
      setNewPassword('')
      toast.success('Encryption key replaced. The old key and recovery key no longer work.')
    }
  }

  async function handleScan() {
    await run('scan', async () => setScan(await scanLegacyAttachments({ api, vault, onProgress: setProgress })))
  }

  async function handleRescue() {
    const result = await run('rescue', () => rescueLegacyAttachments({ api, vault, scan, onProgress: setProgress }))
    if (result) {
      toast.success(`${result.filesRescued} attachment(s) re-encrypted in ${result.notesUpdated} note(s).`)
      setScan(null)
    }
  }

  const pending = status ? pendingTotal(status.pending) : 0

  return (
    <div className="settings-section">
      <div className="settings-block">
        <h3>Encryption status</h3>
        {!status && <p className="settings-help">Loading…</p>}
        {status && (
          <ul className="settings-facts">
            <li>
              Key id <code>{status.vaultKeyId || 'not registered yet'}</code>
            </li>
            <li>
              {status.minEnvelopeVersion >= 3
                ? 'All data uses the current authenticated format; older formats are refused.'
                : `${pending} item(s) still use an older encryption format.`}
            </li>
            {status.rotationStartedAt && <li>A key replacement is in progress. Continue it below.</li>}
          </ul>
        )}
        {status && (pending > 0 || status.rotationStartedAt) && (
          <>
            <p className="settings-help">
              Upgrading re-encrypts older notes, history and attachments in your browser so each one is bound to its slot,
              key and revision. It is safe to interrupt and resume. Nothing is decrypted on the server.
            </p>
            <button type="button" className="btn-primary" disabled={Boolean(busy)} onClick={handleUpgrade}>
              {busy === 'upgrade' ? progressText(progress) || 'Upgrading…' : 'Upgrade encryption format'}
            </button>
          </>
        )}
      </div>

      <form className="settings-block" onSubmit={handleRotate}>
        <h3>Replace encryption key</h3>
        <p className="settings-help">
          Changing your password does not change the key your notes are encrypted with. If you think your password or
          recovery key was exposed, replace the key: everything is re-encrypted under a new key, you set a new password and
          get a new recovery key, and other devices are signed out.
        </p>
        <div className="form-group">
          <label htmlFor="rotate-current">Current password</label>
          <input id="rotate-current" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        </div>
        <div className="form-group">
          <label htmlFor="rotate-new">New password</label>
          <input id="rotate-new" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
        </div>
        <button type="submit" className="btn-danger" disabled={Boolean(busy)}>
          {busy === 'rotate' ? progressText(progress) || 'Replacing…' : 'Replace encryption key'}
        </button>
      </form>

      <div className="settings-block">
        <h3>Attachments from before encryption</h3>
        <p className="settings-help">
          Accounts upgraded by an earlier version kept links to PDFs, audio and other non-image files pointing at
          unencrypted copies on the server. Recovering them encrypts each file and updates the notes that link to it.
        </p>
        {!scan && (
          <button type="button" className="btn-ghost" disabled={Boolean(busy)} onClick={handleScan}>
            {busy === 'scan' ? progressText(progress) || 'Scanning…' : 'Look for unencrypted attachments'}
          </button>
        )}
        {scan && (
          <>
            <p className="settings-help">
              {scan.files.length
                ? `${scan.files.length} file(s) linked from ${scan.notes.length} note(s) can be recovered.`
                : 'Nothing to recover.'}
              {scan.unavailable.length ? ` ${scan.unavailable.length} linked file(s) are no longer on the server.` : ''}
            </p>
            {scan.files.length > 0 && (
              <button type="button" className="btn-primary" disabled={Boolean(busy)} onClick={handleRescue}>
                {busy === 'rescue' ? progressText(progress) || 'Recovering…' : 'Encrypt and recover them'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
