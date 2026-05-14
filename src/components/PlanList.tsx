import { useEffect, useState } from 'react'
import { listPlans, type Plan, type TeamMember } from '../lib/api'
import { namesMatch } from '../lib/names'
import { EmptyState } from './EmptyState'

interface Props {
  currentUserName: string | null
  currentUserEmail: string | null
}

export function PlanList({ currentUserName, currentUserEmail }: Props) {
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Auto-retry once on first failure. The first listPlans call right
    // after a fresh PAT entry can race with cold-start latency or hit
    // a transient PCO blip; retrying saves the user a manual reload.
    let cancelled = false
    const run = async () => {
      try {
        const res = await listPlans()
        if (!cancelled) setPlans(res.data.plans)
      } catch {
        if (cancelled) return
        await new Promise((r) => setTimeout(r, 1500))
        if (cancelled) return
        try {
          const res = await listPlans()
          if (!cancelled) setPlans(res.data.plans)
        } catch (e2: unknown) {
          if (!cancelled) setError((e2 as Error).message)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <div className="error">Error: {error}</div>
  if (!plans) return <div>Loading plans…</div>
  if (plans.length === 0)
    return (
      <EmptyState
        icon="music"
        title="No upcoming plans"
        body={
          <>
            Your Planning Center service plans will show up here. Once
            you've got a plan scheduled, jump in to start picking songs.
          </>
        }
      />
    )

  const myEmail = currentUserEmail?.trim().toLowerCase() ?? ''

  const matchesMe = (m: TeamMember): boolean =>
    (myEmail.length > 0 && m.email != null && m.email.toLowerCase() === myEmail) ||
    namesMatch(m.name, currentUserName)

  const todayMidnight = new Date()
  todayMidnight.setHours(0, 0, 0, 0)
  const todayTs = todayMidnight.getTime()

  const upcoming = plans.filter(
    (p) => !p.sortDate || new Date(p.sortDate).getTime() >= todayTs,
  )

  const renderPlan = (p: Plan) => {
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
          className="pco-quick iconbtn iconbtn-sm iconbtn-pco"
          href={`https://services.planningcenteronline.com/plans/${p.id}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open this plan in Planning Center"
          aria-label="Open this plan in Planning Center"
        >
          <img src="/planning-center-icon.png" alt="" className="iconbtn-img" />
        </a>
        <a
          className={`plan-link${stateClass}`}
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
            {p.sortDate && (
              <span className="date">
                {new Date(p.sortDate).toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            )}
            {(() => {
              const label = nearTermDayLabel(p.sortDate)
              return label ? <span className="day-relative">{label}</span> : null
            })()}
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
                {p.songCounts.filled}/{p.songCounts.total} songs picked
              </span>
            )}
          </div>
        </a>
      </li>
    )
  }

  // Countdown chip — only renders when the service is within ~3 weeks.
  // Past that, the full date in the row is informative enough on its own.
  function nearTermDayLabel(iso: string | null | undefined): string | null {
    if (!iso) return null
    const target = new Date(iso)
    if (Number.isNaN(target.getTime())) return null
    const startOfDay = (d: Date) => {
      const x = new Date(d)
      x.setHours(0, 0, 0, 0)
      return x
    }
    const days = Math.round(
      (startOfDay(target).getTime() - startOfDay(new Date()).getTime()) /
        (1000 * 60 * 60 * 24),
    )
    if (days < 0 || days > 21) return null
    if (days === 0) return 'Today'
    if (days === 1) return 'Tomorrow'
    return `In ${days} days`
  }

  function songsProgressClass({ filled, total }: { filled: number; total: number }): string {
    if (total === 0) return ''
    if (filled === 0) return 'progress-empty'
    if (filled === total) return 'progress-done'
    return 'progress-partial'
  }

  return (
    <div className="plan-list">
      <ul className="plans">{upcoming.map((p) => renderPlan(p))}</ul>
    </div>
  )
}
