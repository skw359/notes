import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Mail,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import Modal from './Modal.jsx'
import { useAuth } from '../context/AuthContext.jsx'

export default function ProfileModal({ isOpen, onClose }) {
  const { authMode, logout, rekeyVault, saveProfile, updateUser, user } = useAuth()
  const navigate = useNavigate()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [file, setFile] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)

  useEffect(() => {
    if (!isOpen || !user) {
      return
    }

    setFirstName(user.first_name || '')
    setLastName(user.last_name || '')
    setFile(null)
    setConfirmDelete(false)
    setCurrentPassword('')
    setNewPassword('')
  }, [isOpen, user])

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)

    try {
      if (authMode === 'e2ee') {
        await saveProfile({ firstName, lastName, file })
      } else {
        const formData = new FormData()
        formData.append('first_name', firstName)
        formData.append('last_name', lastName)
        if (file) formData.append('profile_picture', file)

        const res = await fetch('/api/users/profile', {
          method: 'PUT',
          credentials: 'include',
          body: formData,
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error)
        updateUser(data.user)
      }

      toast.success('Profile updated')
      onClose()
    } catch (error) {
      toast.error(error.message)
    } finally {
      setSaving(false)
    }
  }

  async function handlePasswordChange(e) {
    e.preventDefault()
    setChangingPassword(true)

    try {
      await rekeyVault(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      toast.success('Password changed. Save the new recovery key before closing it.')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setChangingPassword(false)
    }
  }

  async function handleDeleteAccount() {
    try {
      const res = await fetch('/api/users/account', {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to delete account')
      toast.success('Account deleted')
      await logout()
      navigate('/login')
    } catch (error) {
      toast.error(error.message)
    }
  }

  const initials = user
    ? `${user.first_name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase()
    : ''
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || user?.email || 'Your account'
  const profileUploadHint =
    authMode === 'e2ee'
      ? 'JPG only, up to 5MB.'
      : 'JPG only, up to 5MB.'

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        setConfirmDelete(false)
        onClose()
      }}
      contentClassName="profile-modal-shell"
    >
      {(closeModal) =>
        confirmDelete ? (
          <div className="confirm-delete profile-confirm-delete">
            <div className="confirm-delete-icon">
              <Trash2 size={18} />
            </div>
            <div className="confirm-delete-copy">
              <p className="settings-kicker settings-kicker-danger">Danger zone</p>
              <h2>Delete account?</h2>
            </div>
            <p>
              Are you sure you want to delete your account? This action cannot be undone and all
              your notes will be permanently deleted.
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn-ghost profile-secondary-action"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
              <button type="button" className="btn-danger" onClick={handleDeleteAccount}>
                Delete Account
              </button>
            </div>
          </div>
        ) : (
          <div className="settings-modal">
            <div className="settings-modal-hero">
              <button
                type="button"
                className="btn-ghost settings-close-btn"
                onClick={closeModal}
                aria-label="Close settings"
              >
                <X size={18} />
              </button>

              <div className="settings-modal-hero-main">
                <div className="settings-modal-hero-copy">
                  <p className="settings-kicker">Settings</p>
                  <h2>{displayName}</h2>
                  {user?.email && (
                    <span className="settings-meta-item settings-hero-email">
                      <Mail size={14} />
                      {user.email}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="profile-modal-sections">
              <form className="profile-form profile-panel" onSubmit={handleSave}>
                <div className="profile-panel-header">
                  <div className="profile-panel-icon">
                    <UserRound size={18} />
                  </div>
                  <div>
                    <h3>Profile details</h3>
                    <p>Update the name and avatar displayed.</p>
                  </div>
                </div>

                <div className="profile-avatar-section">
                  <div className="profile-avatar-large profile-avatar-large-card">
                    {user?.profile_picture ? <img src={user.profile_picture} alt="Profile" /> : initials}
                  </div>

                  <div className="form-group profile-file-group">
                    <label htmlFor="profile-picture-input">Profile Picture</label>
                    <input
                      id="profile-picture-input"
                      type="file"
                      accept={authMode === 'e2ee' ? 'image/*' : '.jpg,.jpeg'}
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                    />
                    <p className="profile-input-hint">
                      {file ? `Selected: ${file.name}` : profileUploadHint}
                    </p>
                  </div>
                </div>

                <div className="profile-name-grid">
                  <div className="form-group">
                    <label htmlFor="profile-first-name">First Name</label>
                    <input
                      id="profile-first-name"
                      type="text"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="profile-last-name">Last Name</label>
                    <input
                      id="profile-last-name"
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="profile-actions">
                  <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost profile-secondary-action"
                    onClick={closeModal}
                  >
                    Cancel
                  </button>
                </div>
              </form>

              <div className="profile-side-column">
                {authMode === 'e2ee' && (
                  <form className="profile-form profile-panel security-panel" onSubmit={handlePasswordChange}>
                    <div className="profile-panel-header">
                      <div className="profile-panel-icon">
                        <ShieldCheck size={18} />
                      </div>
                      <div>
                        <h3>Security</h3>
                        <p>Rotate your password and generate a fresh recovery key.</p>
                      </div>
                    </div>

                    <div className="form-group">
                      <label htmlFor="profile-current-password">Current Password</label>
                      <input
                        id="profile-current-password"
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        required
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="profile-new-password">New Password</label>
                      <input
                        id="profile-new-password"
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        required
                      />
                    </div>

                    <button type="submit" className="btn-primary" disabled={changingPassword}>
                      {changingPassword ? 'Updating...' : 'Change Password'}
                    </button>
                  </form>
                )}

                <div className="danger-zone profile-panel">
                  <div className="profile-panel-header">
                    <div className="profile-panel-icon profile-panel-icon-danger">
                      <Trash2 size={18} />
                    </div>
                    <div>
                      <h3>Delete account</h3>
                      <p>This action is permanent and cannot be undone.</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete Account
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      }
    </Modal>
  )
}
