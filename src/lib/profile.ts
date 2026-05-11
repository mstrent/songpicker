import { useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { db } from './firebase'

export interface UserProfile {
  leaderName: string
  email: string | null
}

const userRef = (uid: string) => doc(db, 'users', uid)

export function useProfile(user: User | null): UserProfile | null {
  const [profile, setProfile] = useState<UserProfile | null>(null)

  useEffect(() => {
    if (!user) {
      setProfile(null)
      return
    }
    const ref = userRef(user.uid)
    const unsub = onSnapshot(ref, async (snap) => {
      if (snap.exists()) {
        const data = snap.data()
        setProfile({
          leaderName: typeof data.leaderName === 'string' ? data.leaderName : '',
          email: typeof data.email === 'string' ? data.email : user.email,
        })
      } else {
        // First sign-in: seed the profile from the Google displayName.
        await setDoc(ref, {
          leaderName: user.displayName ?? '',
          email: user.email,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
        // The snapshot listener will fire again with the new data.
      }
    })
    return unsub
  }, [user])

  return profile
}

export async function saveLeaderName(uid: string, leaderName: string): Promise<void> {
  await setDoc(
    userRef(uid),
    { leaderName: leaderName.trim(), updatedAt: serverTimestamp() },
    { merge: true },
  )
}
