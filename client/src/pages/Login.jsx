import { useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext.jsx'

export default function Login() {
  const { login, recoverAccount } = useAuth()
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleLoginSubmit(e) {
    e.preventDefault()
    setSubmitting(true)

    try {
      const result = await login(email, password)
      if (result?.migrated) {
        toast.success('Account upgraded to encrypted storage')
      } else {
        toast.success('Welcome back!')
      }
    } catch (error) {
      toast.error(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRecoverySubmit(e) {
    e.preventDefault()
    setSubmitting(true)

    try {
      await recoverAccount(email, recoveryKey, newPassword)
      toast.success('Password reset. Save the new recovery key before closing it.')
      setMode('login')
      setPassword('')
      setRecoveryKey('')
      setNewPassword('')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>{mode === 'login' ? 'Log In' : 'Recover Vault'}</h1>

        {mode === 'login' ? (
          <form onSubmit={handleLoginSubmit}>
            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Logging In...' : 'Log In'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleRecoverySubmit}>
            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Recovery Key</label>
              <input
                type="text"
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Recovering...' : 'Recover Encrypted Account'}
            </button>
          </form>
        )}

        <button
          type="button"
          className="auth-secondary-link"
          onClick={() => setMode((prev) => (prev === 'login' ? 'recover' : 'login'))}
        >
          {mode === 'login' ? 'Use recovery key instead' : 'Back to password login'}
        </button>

        <span className="auth-link">
          Don&apos;t have an account? <Link to="/signup">Sign Up</Link>
        </span>
      </div>
    </div>
  )
}
