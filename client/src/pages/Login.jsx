import { useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext.jsx'
import { MIN_PASSWORD_LENGTH, normalizeRecoveryKey } from '../lib/envelope.js'

export default function Login() {
  const { login, recover } = useAuth()
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
      const result = await login(email.trim(), password)
      if (!result?.legacy) {
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
    let key
    try {
      // CRYPTO-4: spaces, line breaks and invisible characters from copying
      // or the grouped display are ignored.
      key = normalizeRecoveryKey(recoveryKey)
    } catch (error) {
      toast.error(error.message)
      return
    }
    setSubmitting(true)
    try {
      await recover({ email: email.trim(), recoveryKey: key, newPassword })
      toast.success('Password reset. Other devices were signed out.')
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
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="login-password">Password</label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
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
              <label htmlFor="recover-email">Email</label>
              <input
                id="recover-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="recover-key">Recovery Key</label>
              <input
                id="recover-key"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="recover-password">New Password</label>
              <input
                id="recover-password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </div>
            <p className="form-hint">You will get a new recovery key; the one you enter here stops working.</p>
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
