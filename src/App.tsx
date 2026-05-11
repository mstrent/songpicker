import { useEffect, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from './lib/firebase'
import { logOut } from './lib/auth'
import { config } from './config'
import { SignIn } from './components/SignIn'
import { PlanList } from './components/PlanList'
import { PlanDetail } from './components/PlanDetail'

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
  const hash = useHashRoute()

  useEffect(() => onAuthStateChanged(auth, setUser), [])

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
          <span>{user.email}</span>
          <button onClick={() => logOut()}>Sign out</button>
        </div>
      </header>
      <main>
        {planMatch ? (
          <PlanDetail serviceTypeId={planMatch[1]} planId={planMatch[2]} />
        ) : (
          <>
            <h2>Upcoming plans</h2>
            <PlanList currentUserName={user.displayName} />
          </>
        )}
      </main>
    </div>
  )
}
