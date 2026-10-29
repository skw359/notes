import { useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext.jsx'

// Rendered whenever AuthContext's `vaultLocked` is true — i.e. we're
// authenticated but there is no vault key in memory yet: a vault exists,
// just not open in this browser (fresh device or an explicit lock).
export default function VaultUnlockScreen() {
  const { user, logout, unlockVault } = useAuth()
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleUnlockSubmit(e) {
    e.preventDefault()
    setSubmitting(true)

    try {
      await unlockVault(password)
      setPassword('')
      toast.success('Vault unlocked')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Ordinary lock: a vault already exists, just not open here ──────────
  return (
    <div className="vault-lock-screen">
      <div className="vault-lock-card">
        <h1>Unlock Notes</h1>
        <p>
          Your session is active for <strong>{user?.email}</strong>, but your encrypted vault stays
          locked until you re-enter your password.
        </p>
        <form onSubmit={handleUnlockSubmit}>
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="vault-lock-actions">
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Unlocking...' : 'Unlock Vault'}
            </button>
            <button type="button" className="btn-ghost" onClick={logout}>
              Sign Out
            </button>
          </div>
        </form>
        <p className="vault-lock-help">
          If you forgot the password, sign out and use the recovery key flow from the login page.
        </p>
      </div>
    </div>
  )
}
