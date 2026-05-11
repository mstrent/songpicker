import { useEffect, useState } from 'react'
import { listPlans, type Plan } from '../lib/api'
import { namesMatch } from '../lib/names'

interface Props {
  currentUserName: string | null
}

export function PlanList({ currentUserName }: Props) {
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

  return (
    <ul className="plans">
      {plans.map((p) => {
        const heading = p.title || p.seriesTitle || '(no title)'
        const sub = p.title && p.seriesTitle ? p.seriesTitle : null
        const ledByMe = (p.worshipLeaders ?? []).some((n) =>
          namesMatch(n, currentUserName),
        )
        return (
          <li key={`${p.serviceTypeId}/${p.id}`}>
            <a
              className={`plan-link${ledByMe ? ' led-by-me' : ''}`}
              href={`#plan/${p.serviceTypeId}/${p.id}`}
            >
              {ledByMe && <span className="me-flag">You're leading</span>}
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
                {p.worshipLeaders && p.worshipLeaders.length > 0 && (
                  <span className="leaders">led by {p.worshipLeaders.join(', ')}</span>
                )}
              </div>
            </a>
          </li>
        )
      })}
    </ul>
  )
}
