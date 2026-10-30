import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext.jsx'
import { MIN_PASSWORD_LENGTH } from '../lib/envelope.js'

const PHASES = {
  keys: 'Creating your encryption keys…',
  files: 'Encrypting your attachments…',
  notes: 'Encrypting your notes…',
  acknowledge: 'Save your recovery key to continue.',
  commit: 'Finishing the upgrade…',
}

// DATA-5 / CRYPTO-2: the upgrade requires a NEW password (the old one was
// sent to the server in plaintext), shows its progress, and on failure the
// user stays signed in and can retry or keep using the app for now.
export default function LegacyUpgradeScreen() {
  const { upgradeLegacyAccount, setUpgradeDeferred, logout, user } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    if (password !== confirm) {
      toast.error('The passwords do not match')
      return
    }
    setError(null)
    setProgress({ phase: 'keys' })
    try {
      const summary = await upgradeLegacyAccount(password, setProgress)
      // The app switches to the encrypted dashboard right away.
      toast.success(
        `${summary.notes} note(s) (${summary.trashedNotes} in the trash) and ${summary.filesMigrated} attachment(s) are now end-to-end encrypted.`,
        { duration: 8000 }
      )
      if (summary.missingFiles.length) {
        toast.error(
          `${summary.missingFiles.length} referenced file(s) were missing on the server and are shown as placeholders: ${summary.missingFiles.join(', ')}`,
          { duration: 15000 }
        )
      }
    } catch (upgradeError) {
      setError(upgradeError.message)
      setProgress(null)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>
          <ShieldCheck size={22} /> Encrypt your notes
        </h1>
        <p>
          {user?.email}: this account still stores notes in plain text. Choose a <strong>new</strong> password (at least{' '}
          {MIN_PASSWORD_LENGTH} characters) to encrypt them on this device. The old password stops working.
        </p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="upgrade-password">New password</label>
            <input
              id="upgrade-password"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={Boolean(progress)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="upgrade-confirm">Repeat the new password</label>
            <input
              id="upgrade-confirm"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              disabled={Boolean(progress)}
            />
          </div>
          {progress && (
            <p className="form-hint" role="status">
              {PHASES[progress.phase] || 'Working…'}
              {progress.total ? ` ${progress.done ?? 0}/${progress.total}` : ''}
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              The upgrade did not complete: {error}. Nothing was changed; you can retry.
            </p>
          )}
          <button type="submit" className="btn-primary" disabled={Boolean(progress)}>
            {progress ? 'Upgrading…' : error ? 'Retry upgrade' : 'Encrypt my notes'}
          </button>
        </form>
        <button type="button" className="auth-secondary-link" disabled={Boolean(progress)} onClick={() => setUpgradeDeferred(true)}>
          Not now
        </button>
        <button type="button" className="auth-secondary-link" disabled={Boolean(progress)} onClick={logout}>
          Log out
        </button>
      </div>
    </div>
  )
}
