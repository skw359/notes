import { useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext.jsx'
import { MIN_PASSWORD_LENGTH } from '../lib/envelope.js'

export default function Signup() {
  const { signup } = useAuth()
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [needsInvite, setNeedsInvite] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await signup({ email: email.trim(), password, firstName, lastName, inviteCode: inviteCode.trim() || undefined })
    } catch (error) {
      // SEC-7: registration can be closed or invite-only on this server.
      if (error.code === 'INVITE_REQUIRED') {
        setNeedsInvite(true)
      }
      toast.error(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Sign Up</h1>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="signup-email">Email</label>
            <input
              id="signup-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="name-row">
            <div className="form-group">
              <label htmlFor="signup-first">First Name</label>
              <input id="signup-first" type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
            </div>
            <div className="form-group">
              <label htmlFor="signup-last">Last Name</label>
              <input id="signup-last" type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="signup-password">Password</label>
            <input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
            />
            <p className="form-hint">
              At least {MIN_PASSWORD_LENGTH} characters. It encrypts your notes and cannot be reset without your recovery
              key.
            </p>
          </div>
          {needsInvite && (
            <div className="form-group">
              <label htmlFor="signup-invite">Invite code</label>
              <input id="signup-invite" type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required />
            </div>
          )}
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? 'Creating Account...' : 'Sign Up'}
          </button>
        </form>
        <span className="auth-link">
          Already have an account? <Link to="/login">Log In</Link>
        </span>
      </div>
    </div>
  )
}
