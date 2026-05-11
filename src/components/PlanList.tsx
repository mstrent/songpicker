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

  const past: Plan[] = []
  const upcoming: Plan[] = []
  for (const p of plans) {
    const isPast = p.sortDate && new Date(p.sortDate).getTime() < todayTs
    if (isPast) past.push(p)
    else upcoming.push(p)
  }

  const renderPlan = (p: Plan, isPast: boolean) => {
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
    return (
      <li key={`${p.serviceTypeId}/${p.id}`}>
        <a
          className={`plan-link${stateClass}${isPast ? ' past' : ''}`}
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
            {p.songCounts && p.songCounts.total > 0 && (
              <span
                className={`songs-progress ${songsProgressClass(p.songCounts)}`}
                title={
                  p.songCounts.filled === p.songCounts.total
                    ? 'All songs picked'
                    : `${p.songCounts.total - p.songCounts.filled} song${
                        p.songCounts.total - p.songCounts.filled === 1 ? '' : 's'
                      } left to pick`
                }
              >
                {p.songCounts.filled}/{p.songCounts.total} songs
              </span>
            )}
          </div>
        </a>
      </li>
    )
  }

  function songsProgressClass({ filled, total }: { filled: number; total: number }): string {
    if (total === 0) return ''
    if (filled === 0) return 'progress-empty'
    if (filled === total) return 'progress-done'
    return 'progress-partial'
  }

  const pastCountLabel =
    past.length === 1 ? '1 recent past service' : `${past.length} recent past services`
  const myPastCount = past.filter((p) => (p.teamMembers ?? []).some(matchesMe)).length

  return (
    <div className="plan-list">
      {past.length > 0 && (
        <details className="past-plans-group">
          <summary>
            <span className="chevron" aria-hidden>
              ▸
            </span>
            <span>{pastCountLabel}</span>
            {myPastCount > 0 && (
              <span className="past-served-count">
                · you served in {myPastCount}
              </span>
            )}
          </summary>
          <ul className="plans past-plans-list">
            {past.map((p) => renderPlan(p, true))}
          </ul>
        </details>
      )}
      <ul className="plans">{upcoming.map((p) => renderPlan(p, false))}</ul>
    </div>
  )
}
