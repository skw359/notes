import { useState } from 'react'
import { LogOut, Menu, Moon, Sun } from 'lucide-react'
import toast from 'react-hot-toast'
import ProfileModal from './ProfileModal.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'

export default function Header({ onToggleSidebar }) {
  const { logout, user } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const [profileOpen, setProfileOpen] = useState(false)

  async function handleLogout() {
    await logout()
    toast.success('Logged out')
  }

  const initials = user
    ? `${user.first_name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase()
    : ''

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
          <div className="avatar" onClick={() => setProfileOpen(true)} title="Profile">
            {user?.profile_picture ? <img src={user.profile_picture} alt="Profile" /> : initials}
          </div>
          <button className="btn-ghost" onClick={handleLogout} title="Logout">
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <ProfileModal isOpen={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  )
}
