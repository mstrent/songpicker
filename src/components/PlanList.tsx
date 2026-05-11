import { useEffect, useState } from 'react'
import { listPlans, type Plan } from '../lib/api'

export function PlanList() {
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
      {plans.map((p) => (
        <li key={p.id}>
          <div className="title">{p.title || '(untitled)'}</div>
          {p.seriesTitle && <div className="series">{p.seriesTitle}</div>}
          {p.sortDate && (
            <div className="date">{new Date(p.sortDate).toLocaleDateString()}</div>
          )}
        </li>
      ))}
    </ul>
  )
}
