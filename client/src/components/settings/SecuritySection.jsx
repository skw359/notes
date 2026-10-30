import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Monitor } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '../../context/AuthContext.jsx'
import { AUTO_LOCK_CHOICES } from '../../lib/deviceSettings.js'
import { MIN_PASSWORD_LENGTH, isWeakKdf } from '../../lib/envelope.js'

function describeAgent(userAgent) {
  if (!userAgent) return 'Unknown device'
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser'
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /iPhone|iPad/.test(userAgent)
      ? 'iOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : ''
  return [browser, os].filter(Boolean).join(' on ')
}

function PasswordChange() {
  const { changePassword, session } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const weak = isWeakKdf(session?.bootstrap?.kdfParams)

  async function handleSubmit(event) {
    event.preventDefault()
    if (next !== repeat) {
      toast.error('The new passwords do not match')
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setRepeat('')
      toast.success('Password changed. Other devices were signed out; your recovery key still works.')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="settings-block" onSubmit={handleSubmit}>
      <h3>Password</h3>
      {weak && (
        <p className="settings-notice">
          <AlertTriangle size={14} /> Your password is protected with older, weaker key-derivation settings. Changing it
          upgrades them.
        </p>
      )}
      <p className="settings-help">
        Changing the password re-wraps your encryption key; your recovery key stays the same. To replace the encryption
        key itself (for example after a suspected compromise), use Encryption &rsaquo; Replace encryption key.
      </p>
      <div className="form-group">
        <label htmlFor="security-current">Current password</label>
        <input id="security-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="form-group">
        <label htmlFor="security-new">New password</label>
        <input id="security-new" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={next} onChange={(e) => setNext(e.target.value)} required />
      </div>
      <div className="form-group">
        <label htmlFor="security-repeat">Repeat new password</label>
        <input id="security-repeat" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
      </div>
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? 'Updating…' : 'Change password'}
      </button>
    </form>
  )
}

function RecoveryKey() {
  const { regenerateRecoveryKey, session } = useAuth()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const updatedAt = session?.bootstrap?.recoveryKeyUpdatedAt

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    try {
      await regenerateRecoveryKey(password)
      setPassword('')
      toast.success('New recovery key saved. The old one no longer works.')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="settings-block" onSubmit={handleSubmit}>
      <h3>Recovery key</h3>
      <p className="settings-help">
        {updatedAt ? `Last generated ${new Date(updatedAt).toLocaleDateString()}. ` : ''}
        Lost it, or worried someone saw it? Generate a new one. The current key keeps working until you confirm you saved
        the new one.
      </p>
      <div className="form-group">
        <label htmlFor="recovery-password">Password</label>
        <input id="recovery-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      <button type="submit" className="btn-ghost" disabled={busy}>
        {busy ? 'Preparing…' : 'Generate a new recovery key'}
      </button>
    </form>
  )
}

function Sessions() {
  const { api } = useAuth()
  const [sessions, setSessions] = useState(null)

  const load = useCallback(() => {
    api
      .get('/api/auth/sessions')
      .then((data) => setSessions(data.sessions))
      .catch((error) => toast.error(error.message))
  }, [api])

  useEffect(load, [load])

  async function revoke(id) {
    try {
      await api.delete(`/api/auth/sessions/${id}`)
      load()
    } catch (error) {
      toast.error(error.message)
    }
  }

  async function revokeOthers() {
    try {
      const { revoked } = await api.post('/api/auth/sessions/revoke-others')
      toast.success(`Signed out ${revoked} other session(s)`)
      load()
    } catch (error) {
      toast.error(error.message)
    }
  }

  return (
    <div className="settings-block">
      <h3>Signed-in devices</h3>
      <ul className="session-list">
        {sessions?.map((item) => (
          <li key={item.id}>
            <Monitor size={14} />
            <div>
              <strong>{describeAgent(item.userAgent)}</strong>
              {item.current && <span className="badge">This device</span>}
              <span className="settings-help">
                Last active {new Date(item.lastSeenAt).toLocaleString()}
                {item.ip ? ` · ${item.ip}` : ''}
              </span>
            </div>
            {!item.current && (
              <button type="button" className="btn-link" onClick={() => revoke(item.id)}>
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="btn-ghost" onClick={revokeOthers}>
        Sign out all other devices
      </button>
    </div>
  )
}

function DeviceSettings() {
  const { deviceSettings, updateDeviceSettings } = useAuth()
  return (
    <div className="settings-block">
      <h3>This device</h3>
      <div className="form-group">
        <label htmlFor="auto-lock">Lock the vault after inactivity</label>
        <select
          id="auto-lock"
          value={deviceSettings.autoLockMinutes}
          onChange={(e) => updateDeviceSettings({ autoLockMinutes: Number(e.target.value) })}
        >
          {AUTO_LOCK_CHOICES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 0 ? 'Never' : minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour(s)`}
            </option>
          ))}
        </select>
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={deviceSettings.keepCacheOnLogout}
          onChange={(e) => updateDeviceSettings({ keepCacheOnLogout: e.target.checked })}
        />
        Keep the encrypted cache on this device after logging out (faster sign-in; leave off on shared computers)
      </label>
    </div>
  )
}

export default function SecuritySection() {
  return (
    <div className="settings-section">
      <PasswordChange />
      <RecoveryKey />
      <Sessions />
      <DeviceSettings />
    </div>
  )
}
