import { useEffect, useState } from 'react'
import { listPlans, type Plan, type TeamMember } from '../lib/api'
import { namesMatch } from '../lib/names'

interface Props {
  currentUserName: string | null
  currentUserEmail: string | null
}

export function PlanList({ currentUserName, currentUserEmail }: Props) {
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listPlans()
      .then((res) => setPlans(res.data.plans))
      .catch((e: Error) => setError(e.message))
  }, [])

  if (error) return <div className="error">Error: {error}</div>
  if (!plans) return <div>Loading plans…</div>
  if (plans.length === 0) return <div>No upcoming plans found.</div>

  const myEmail = currentUserEmail?.trim().toLowerCase() ?? ''

  const matchesMe = (m: TeamMember): boolean =>
    (myEmail.length > 0 && m.email != null && m.email.toLowerCase() === myEmail) ||
    namesMatch(m.name, currentUserName)

  const todayMidnight = new Date()
  todayMidnight.setHours(0, 0, 0, 0)
  const todayTs = todayMidnight.getTime()

  return (
    <ul className="plans">
      {plans.map((p) => {
        const heading = p.title || p.seriesTitle || '(no title)'
        const sub = p.title && p.seriesTitle ? p.seriesTitle : null
        const team = p.teamMembers ?? []
        const leaders = team.filter((m) => m.position === 'Worship Leader')
        const ledByMe = leaders.some(matchesMe)
        const onTeam = !ledByMe && team.some(matchesMe)
        const myRoles = onTeam
          ? Array.from(
              new Set(
                team
                  .filter(matchesMe)
                  .map((m) => m.position)
                  .filter((p): p is string => !!p),
              ),
            )
          : []
        const stateClass = ledByMe ? ' led-by-me' : onTeam ? ' on-team' : ''
        const past = !!(
          p.sortDate && new Date(p.sortDate).getTime() < todayTs
        )
        return (
          <li key={`${p.serviceTypeId}/${p.id}`}>
            <a
              className={`plan-link${stateClass}${past ? ' past' : ''}`}
              href={`#plan/${p.serviceTypeId}/${p.id}`}
            >
              {ledByMe && <span className="me-flag">You're leading</span>}
              {onTeam && (
                <span className="me-flag on-team-flag">
                  You're serving
                  {myRoles.length > 0 && ` · ${myRoles.join(', ')}`}
                </span>
              )}
              <div className="title">{heading}</div>
              {sub && <div className="series">{sub}</div>}
              <div className="meta-row">
                {p.serviceTypeName && (
                  <span className="service-type">{p.serviceTypeName}</span>
                )}
                {p.sortDate && (
                  <span className="date">
                    {new Date(p.sortDate).toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                )}
                {leaders.length > 0 && (
                  <span className="leaders">
                    led by {leaders.map((l) => l.name).join(', ')}
                  </span>
                )}
              </div>
            </a>
          </li>
        )
      })}
    </ul>
  )
}
