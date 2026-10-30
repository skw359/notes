import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import PageTransition from './components/PageTransition.jsx'
import RecoveryKeyModal from './components/RecoveryKeyModal.jsx'
import { useAuth } from './context/AuthContext.jsx'

const Login = lazy(() => import('./pages/Login.jsx'))
const Signup = lazy(() => import('./pages/Signup.jsx'))
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'))
const Landing = lazy(() => import('./pages/Landing.jsx'))
const LegacyUpgradeScreen = lazy(() => import('./components/LegacyUpgradeScreen.jsx'))

function HomeRoute() {
  const { user, loading, authMode, upgradeDeferred } = useAuth()
  if (loading) return null
  if (!user) return <PageTransition><Landing /></PageTransition>
  // Pre-encryption accounts are offered the upgrade first (DATA-5: never a
  // forced logout if it fails or is postponed).
  if (authMode === 'legacy' && !upgradeDeferred) return <PageTransition><LegacyUpgradeScreen /></PageTransition>
  return <PageTransition><Dashboard /></PageTransition>
}

function GuestRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (user) return <Navigate to="/" replace />
  return children
}

function App() {
  return (
    <>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            fontFamily: "'Montserrat', sans-serif",
            borderRadius: '12px',
          },
        }}
      />
      <RecoveryKeyModal />
      <Suspense fallback={null}>
        <Routes>
          <Route
            path="/login"
            element={
              <GuestRoute>
                <PageTransition>
                  <Login />
                </PageTransition>
              </GuestRoute>
            }
          />
          <Route
            path="/signup"
            element={
              <GuestRoute>
                <PageTransition>
                  <Signup />
                </PageTransition>
              </GuestRoute>
            }
          />
          <Route path="/" element={<HomeRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  )
}

export default App
