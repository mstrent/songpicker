import { useEffect, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from './lib/firebase'
import { logOut } from './lib/auth'
import { config } from './config'
import { SignIn } from './components/SignIn'
import { PlanList } from './components/PlanList'

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)

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

  return (
    <div className="app">
      <header>
        <h1>songpicker</h1>
        <div className="who">
          {user.email} <button onClick={() => logOut()}>Sign out</button>
        </div>
      </header>
      <main>
        <h2>Upcoming plans</h2>
        <PlanList />
      </main>
    </div>
  )
}
