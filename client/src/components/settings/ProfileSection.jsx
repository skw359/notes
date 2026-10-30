import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../../context/AuthContext.jsx'

function formatMegabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

export default function ProfileSection({ onClose }) {
  const { api, authMode, saveProfile, user } = useAuth()
  const [firstName, setFirstName] = useState(user?.first_name || '')
  const [lastName, setLastName] = useState(user?.last_name || '')
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [maxBytes, setMaxBytes] = useState(null)

  useEffect(() => {
    if (authMode !== 'e2ee') {
      return
    }
    api
      .get('/api/blobs/usage')
      .then((usage) => setMaxBytes(usage.maxBlobBytes))
      .catch(() => {})
  }, [api, authMode])

  async function handleSave(event) {
    event.preventDefault()
    if (file && maxBytes && file.size > maxBytes) {
      toast.error(`The picture is larger than ${formatMegabytes(maxBytes)}`)
      return
    }
    setSaving(true)
    try {
      if (authMode === 'e2ee') {
        await saveProfile({ firstName, lastName, file })
      } else {
        await api.put('/api/users/profile', { first_name: firstName, last_name: lastName })
      }
      toast.success('Profile updated')
      onClose()
    } catch (error) {
      toast.error(error.message)
    } finally {
      setSaving(false)
    }
  }

  const initials = `${user?.first_name?.[0] || ''}${user?.last_name?.[0] || ''}`.toUpperCase()

  return (
    <form className="profile-form profile-panel" onSubmit={handleSave}>
      <div className="profile-avatar-section">
        <div className="profile-avatar-large profile-avatar-large-card">
          {user?.profile_picture ? <img src={user.profile_picture} alt="" /> : initials}
        </div>
        {authMode === 'e2ee' && (
          <div className="form-group profile-file-group">
            <label htmlFor="profile-picture-input">Profile picture</label>
            <input
              id="profile-picture-input"
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            <p className="profile-input-hint">
              {file
                ? `Selected: ${file.name}`
                : `Any image up to ${maxBytes ? formatMegabytes(maxBytes) : '25 MB'}. Encrypted before upload.`}
            </p>
          </div>
        )}
      </div>
      <div className="profile-name-grid">
        <div className="form-group">
          <label htmlFor="profile-first-name">First name</label>
          <input id="profile-first-name" type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
        </div>
        <div className="form-group">
          <label htmlFor="profile-last-name">Last name</label>
          <input id="profile-last-name" type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
        </div>
      </div>
      <div className="profile-actions">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving...' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}
