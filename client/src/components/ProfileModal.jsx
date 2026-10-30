import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mail, X } from 'lucide-react'
import toast from 'react-hot-toast'
import ConfirmDialog from './ConfirmDialog.jsx'
import Modal from './Modal.jsx'
import EncryptionSection from './settings/EncryptionSection.jsx'
import ImportSection from './settings/ImportSection.jsx'
import ProfileSection from './settings/ProfileSection.jsx'
import SecuritySection from './settings/SecuritySection.jsx'
import { useAuth } from '../context/AuthContext.jsx'

function DangerSection() {
  const { authMode, deleteAccount, logout, api } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  // SEC-6: deletion needs the password and a typed confirmation.
  async function handleDelete() {
    setBusy(true)
    try {
      if (authMode === 'e2ee') {
        await deleteAccount(password)
      } else {
        await api.delete('/api/users/account', { confirm: 'DELETE', password })
        await logout()
      }
      toast.success('Account deleted')
      navigate('/login')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setBusy(false)
      setPassword('')
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-block danger-zone">
        <h3>Delete account</h3>
        <p className="settings-help">
          Deletes your account, every note, all history and all attachments from the server. This cannot be undone.
        </p>
        <button type="button" className="btn-danger" onClick={() => setOpen(true)}>
          Delete account…
        </button>
      </div>
      <ConfirmDialog
        isOpen={open}
        title="Delete your account?"
        message="Everything stored for this account will be permanently deleted."
        confirmLabel="Delete account"
        danger
        busy={busy}
        requireText="DELETE"
        onConfirm={handleDelete}
        onCancel={() => {
          setOpen(false)
          setPassword('')
        }}
      >
        <div className="form-group">
          <label htmlFor="delete-password">Password</label>
          <input
            id="delete-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </ConfirmDialog>
    </div>
  )
}

const TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'security', label: 'Security', e2ee: true },
  { id: 'encryption', label: 'Encryption', e2ee: true },
  { id: 'import', label: 'Import', e2ee: true },
  { id: 'danger', label: 'Delete account' },
]

export default function ProfileModal({ isOpen, onClose }) {
  const { authMode, user } = useAuth()
  const [tab, setTab] = useState('profile')
  const tabs = TABS.filter((entry) => !entry.e2ee || authMode === 'e2ee')
  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || 'Your account'

  return (
    <Modal isOpen={isOpen} onClose={onClose} contentClassName="profile-modal-shell" labelledBy="settings-title">
      {(closeModal) => (
        <div className="settings-modal">
          <div className="settings-modal-hero">
            <button type="button" className="btn-ghost settings-close-btn" onClick={closeModal} aria-label="Close settings">
              <X size={18} />
            </button>
            <div className="settings-modal-hero-main">
              <div className="settings-modal-hero-copy">
                <p className="settings-kicker">Settings</p>
                <h2 id="settings-title">{displayName}</h2>
                {user?.email && (
                  <span className="settings-meta-item settings-hero-email">
                    <Mail size={14} />
                    {user.email}
                  </span>
                )}
              </div>
            </div>
            <nav className="settings-tabs" role="tablist">
              {tabs.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  className={`settings-tab ${tab === entry.id ? 'active' : ''}`}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
          </div>
          <div className="profile-modal-sections settings-tab-body">
            {tab === 'profile' && <ProfileSection onClose={closeModal} />}
            {tab === 'security' && <SecuritySection />}
            {tab === 'encryption' && <EncryptionSection />}
            {tab === 'import' && <ImportSection />}
            {tab === 'danger' && <DangerSection />}
          </div>
        </div>
      )}
    </Modal>
  )
}
