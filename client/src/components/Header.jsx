import { useState } from 'react'
import { Lock, LogOut, Menu, Moon, Sun } from 'lucide-react'
import toast from 'react-hot-toast'
import ProfileModal from './ProfileModal.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'

export default function Header({ onToggleSidebar }) {
  const { authMode, lock, logout, unsentEditCount, user } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const [profileOpen, setProfileOpen] = useState(false)

  async function handleLogout() {
    await logout()
    const unsent = await unsentEditCount()
    if (unsent) {
      toast(`${unsent} unsent change(s) stay encrypted on this device and are sent the next time you sign in here.`, {
        duration: 8000,
      })
    } else {
      toast.success('Logged out')
    }
  }

  async function handleLock() {
    if (!(await lock('manual'))) {
      toast.error('Some changes could not be stored safely yet, so the vault stays unlocked. Try again in a moment.')
    }
  }

  const initials = user ? `${user.first_name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase() : ''

  return (
    <>
      <header className="header">
        <div className="header-left">
          <button className="btn-ghost menu-btn" onMouseDown={(e) => e.preventDefault()} onClick={onToggleSidebar}>
            <Menu size={20} />
          </button>
          <h1>Notes</h1>
        </div>
        <div className="header-right">
          <button className="btn-ghost" onClick={toggleTheme} title="Toggle theme">
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          {authMode === 'e2ee' && (
            <button className="btn-ghost" onClick={handleLock} title="Lock the vault">
              <Lock size={18} />
            </button>
          )}
          <button type="button" className="avatar" onClick={() => setProfileOpen(true)} title="Settings">
            {user?.profile_picture ? <img src={user.profile_picture} alt="" /> : initials}
          </button>
          <button className="btn-ghost" onClick={handleLogout} title="Log out">
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <ProfileModal isOpen={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  )
}
