import { useState } from 'react'
import { Lock } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext.jsx'

// DATA-2: when the session expires the editor and unsent edits stay where
// they are; signing in again resumes saving without reloading anything.
export default function SessionExpiredBanner() {
  const { reauthenticate, user } = useAuth()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    try {
      const result = await reauthenticate(password)
      setPassword('')
      toast.success(result.relock ? 'Signed in. Unlock to continue with the new key.' : 'Signed in again. Saving resumed.')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="banner banner-error session-banner" onSubmit={handleSubmit} role="alert">
      <Lock size={16} />
      <div className="banner-body">
        <strong>Your session expired. Your changes are kept on this device.</strong>
        <span>Enter the password for {user?.email} to continue saving.</span>
        <div className="banner-actions">
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </div>
    </form>
  )
}
