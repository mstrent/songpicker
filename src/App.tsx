import { useCallback, useEffect, useRef, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from './lib/firebase'
import { logOut } from './lib/auth'
import { getAdminStatus, getPcoStatus } from './lib/api'
import { config } from './config'
import { SignIn } from './components/SignIn'
import { PlanList } from './components/PlanList'
import { PlanDetail } from './components/PlanDetail'
import { PcoSetup } from './components/PcoSetup'
import { AdminPage } from './components/AdminPage'
import { Icon } from './components/Icon'

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [pcoReady, setPcoReady] = useState<boolean | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const hash = useHashRoute()

  useEffect(() => {
    if (!userMenuOpen) return
    const onDocPointer = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUserMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [userMenuOpen])

  useEffect(() => onAuthStateChanged(auth, setUser), [])

  const refreshPcoStatus = useCallback(async () => {
    try {
      const res = await getPcoStatus()
      setPcoReady(res.data.hasCredentials)
    } catch {
      setPcoReady(false)
    }
  }, [])

  useEffect(() => {
    if (user) {
      // Reset to loading-state on user change, then fan out async fetches.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPcoReady(null)
      setIsAdmin(false)
      void refreshPcoStatus()
      getAdminStatus()
        .then((res) => setIsAdmin(res.data.isAdmin))
        .catch((e) => {
          // Surface the reason — most likely a stale emulator that hasn't
          // reloaded ADMIN_EMAILS from functions/.env, or the function
          // hasn't been deployed yet in prod.
          console.warn('[admin] getAdminStatus failed:', e)
          setIsAdmin(false)
        })
    } else {
      setPcoReady(null)
      setIsAdmin(false)
    }
  }, [user, refreshPcoStatus])

  if (user === undefined) return <div className="centered">Loading…</div>
  if (!user) return <SignIn />

  if (config.allowedEmail && user.email !== config.allowedEmail) {
    return (
      <div className="centered">
        <p>
          {user.email} isn't authorized.{' '}
          <button onClick={() => logOut()}>Sign out</button>
        </p>
      </div>
    )
  }

  const planMatch = hash.match(/^#plan\/([^/]+)\/([^/]+)$/)
  const onAdmin = hash === '#admin'

  // Some Firebase setups end up with user.displayName=null even when Google
  // provides a name via providerData. Fall through to the provider record.
  const leaderName =
    user.displayName ||
    user.providerData.find((p) => p.providerId === 'google.com')?.displayName ||
    user.providerData[0]?.displayName ||
    ''

  return (
    <div className="app">
      <header>
        <h1>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              window.location.hash = ''
            }}
          >
            song<span className="accent">picker</span>
          </a>
        </h1>
        <div className="who">
          <div className="user-menu" ref={userMenuRef}>
            <button
              type="button"
              className="user-menu-trigger icon-text"
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              onClick={() => setUserMenuOpen((v) => !v)}
            >
              <span className="email">{user.email}</span>
              <Icon
                name="chevron-down"
                size={12}
                className={`user-menu-caret${userMenuOpen ? ' is-open' : ''}`}
              />
            </button>
            {userMenuOpen && (
              <div className="user-menu-items" role="menu">
                {isAdmin && (
                  <a
                    className="user-menu-item icon-text"
                    href="#admin"
                    role="menuitem"
                    onClick={() => setUserMenuOpen(false)}
                  >
                    Admin
                    <Icon name="settings" size={14} />
                  </a>
                )}
                <button
                  type="button"
                  className="user-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setUserMenuOpen(false)
                    void logOut()
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main>
        {onAdmin ? (
          isAdmin ? (
            <AdminPage />
          ) : (
            <div className="centered">
              <p>Admin access required.</p>
              <a href="#">← Back</a>
            </div>
          )
        ) : pcoReady === null ? (
          <div>Checking Planning Center connection…</div>
        ) : pcoReady === false ? (
          <PcoSetup onSaved={() => void refreshPcoStatus()} />
        ) : planMatch ? (
          <PlanDetail serviceTypeId={planMatch[1]} planId={planMatch[2]} />
        ) : (
          <>
            <h2>Upcoming services</h2>
            <PlanList currentUserName={leaderName} currentUserEmail={user.email} />
          </>
        )}
      </main>
    </div>
  )
}
