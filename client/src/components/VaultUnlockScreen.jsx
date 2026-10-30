import { useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext.jsx'

// Authenticated, but the vault key is not in memory (reload, auto-lock or a
// manual lock). Unsent edits wait, encrypted, in the outbox.
export default function VaultUnlockScreen() {
  const { user, logout, unlock, lockNotice } = useAuth()
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleUnlockSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await unlock(password)
      setPassword('')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="vault-lock-screen">
      <div className="vault-lock-card">
        <h1>Unlock Notes</h1>
        {lockNotice && <p className="vault-lock-notice">{lockNotice}</p>}
        <p>
          Signed in as <strong>{user?.email}</strong>. Your notes stay encrypted until you enter your password on this
          device.
        </p>
        <form onSubmit={handleUnlockSubmit}>
          <div className="form-group">
            <label htmlFor="unlock-password">Password</label>
            <input
              id="unlock-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="vault-lock-actions">
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Unlocking...' : 'Unlock'}
            </button>
            <button type="button" className="btn-ghost" onClick={logout}>
              Sign Out
            </button>
          </div>
        </form>
        <p className="vault-lock-help">
          Forgot the password? Sign out and choose &ldquo;Use recovery key instead&rdquo; on the login page.
        </p>
      </div>
    </div>
  )
}
