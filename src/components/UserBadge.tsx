import { useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'
import { logOut } from '../lib/auth'
import { saveLeaderName, type UserProfile } from '../lib/profile'

interface Props {
  user: User
  profile: UserProfile | null
}

export function UserBadge({ user, profile }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(profile?.leaderName ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setDraft(profile?.leaderName ?? '')
  }, [profile?.leaderName, editing])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  async function commit() {
    const next = draft.trim()
    if (next !== (profile?.leaderName ?? '')) {
      await saveLeaderName(user.uid, next)
    }
    setEditing(false)
  }

  return (
    <div className="who">
      <span className="email">{user.email}</span>
      <span className="leader-name-row">
        leading as{' '}
        {editing ? (
          <input
            ref={inputRef}
            className="leader-name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setDraft(profile?.leaderName ?? '')
                setEditing(false)
              }
            }}
            placeholder="Your PCO name"
          />
        ) : (
          <button
            type="button"
            className="leader-name-btn"
            onClick={() => setEditing(true)}
            title="Edit your PCO leader name"
          >
            {profile?.leaderName || 'set name'}
          </button>
        )}
      </span>
      <button onClick={() => logOut()}>Sign out</button>
    </div>
  )
}
