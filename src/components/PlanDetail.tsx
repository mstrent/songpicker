import { useEffect, useRef, useState } from 'react'
import {
  getPlanContext,
  searchSongs,
  suggestSongs,
  type Plan,
  type PlanItem,
  type PlanNote,
  type Song,
  type SongSuggestion,
} from '../lib/api'

interface CandidateMatch {
  suggestion: SongSuggestion
  status: 'checking' | 'matched' | 'unmatched' | 'error'
  song?: Song
  error?: string
}

interface Props {
  serviceTypeId: string
  planId: string
}

export function PlanDetail({ serviceTypeId, planId }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [notes, setNotes] = useState<PlanNote[] | null>(null)
  const [items, setItems] = useState<PlanItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [theme, setTheme] = useState('')
  const [criteria, setCriteria] = useState('')
  const [count, setCount] = useState(8)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<CandidateMatch[]>([])

  const themeInitialized = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    setPlan(null)
    setNotes(null)
    setItems(null)
    themeInitialized.current = false

    getPlanContext({ serviceTypeId, planId })
      .then((res) => {
        if (cancelled) return
        setPlan(res.data.plan)
        setNotes(res.data.notes)
        setItems(res.data.items)
        if (!themeInitialized.current) {
          setTheme(res.data.plan.seriesTitle ?? res.data.plan.title ?? '')
          themeInitialized.current = true
        }
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))

    return () => {
      cancelled = true
    }
  }, [serviceTypeId, planId])

  async function handleSuggest() {
    if (!theme.trim() || generating) return
    setGenerating(true)
    setGenerateError(null)
    try {
      const exclude = candidates.map((c) => c.suggestion.title)
      const res = await suggestSongs({ theme, criteria, exclude, count })

      const startIndex = candidates.length
      const newOnes: CandidateMatch[] = res.data.suggestions.map((s) => ({
        suggestion: s,
        status: 'checking',
      }))
      setCandidates((prev) => [...prev, ...newOnes])

      newOnes.forEach((c, i) => {
        const idx = startIndex + i
        searchSongs({ query: c.suggestion.title })
          .then((sr) => {
            const match = pickBestMatch(c.suggestion.title, sr.data.songs)
            setCandidates((prev) => updateAt(prev, idx, (cur) =>
              match
                ? { ...cur, status: 'matched', song: match }
                : { ...cur, status: 'unmatched' },
            ))
          })
          .catch((e: Error) => {
            setCandidates((prev) =>
              updateAt(prev, idx, (cur) => ({ ...cur, status: 'error', error: e.message })),
            )
          })
      })
    } catch (e) {
      setGenerateError((e as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  function clearCandidates() {
    setCandidates([])
  }

  if (loadError) return <div className="error">Error loading plan: {loadError}</div>
  if (!plan || !notes || !items) return <div>Loading plan…</div>

  const subtitle = plan.title && plan.seriesTitle ? plan.seriesTitle : null

  return (
    <div className="plan-detail">
      <a
        className="back"
        href="#"
        onClick={(e) => {
          e.preventDefault()
          window.location.hash = ''
        }}
      >
        ← All plans
      </a>

      <h2>{plan.title || plan.seriesTitle || '(no title)'}</h2>
      <div className="meta">
        {subtitle && <span>{subtitle} · </span>}
        {plan.sortDate && new Date(plan.sortDate).toLocaleDateString()}
        {plan.worshipLeaders && plan.worshipLeaders.length > 0 && (
          <> · led by {plan.worshipLeaders.join(', ')}</>
        )}
      </div>

      {items.length > 0 && (
        <section className="service-order">
          <h3>Service order</h3>
          <ol>
            {items.map((it) => (
              <li key={it.id} className={`item type-${it.itemType}`}>
                <span className="seq">{it.sequence}</span>
                <span className="ititle">{it.title || '(no title)'}</span>
                {it.itemType === 'song' &&
                  (it.songTitle ? (
                    <span className="song-attached">{it.songTitle}</span>
                  ) : (
                    <span className="song-empty">(no song picked)</span>
                  ))}
                <span className={`badge type-${it.itemType}`}>{it.itemType}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {notes.length > 0 ? (
        <section className="notes">
          <h3>Plan context</h3>
          <ul>
            {notes.map((n) => (
              <li key={n.id}>
                {n.category && <strong>{n.category}: </strong>}
                <span>{n.content}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="muted">No plan notes set in PCO.</p>
      )}

      <section className="criteria">
        <h3>Suggest songs</h3>
        <label>
          <span>Theme</span>
          <input
            type="text"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder="What is the service about?"
          />
        </label>
        <label>
          <span>Criteria (mood, tempo, era, must-include, avoid)</span>
          <textarea
            rows={4}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder="e.g. upbeat opener, slower communion song, include 'Cornerstone'"
          />
        </label>
        <div className="row">
          <label className="inline">
            <span>How many?</span>
            <input
              type="number"
              min={1}
              max={20}
              value={count}
              onChange={(e) => setCount(parseInt(e.target.value, 10) || 8)}
            />
          </label>
          <button onClick={handleSuggest} disabled={generating || !theme.trim()}>
            {generating ? 'Generating…' : candidates.length > 0 ? 'Suggest more' : 'Suggest songs'}
          </button>
          {candidates.length > 0 && (
            <button className="ghost" onClick={clearCandidates} disabled={generating}>
              Clear
            </button>
          )}
        </div>
        {generateError && <div className="error">Error: {generateError}</div>}
      </section>

      {candidates.length > 0 && (
        <section className="candidates">
          <h3>Candidates ({candidates.length})</h3>
          <ul>
            {candidates.map((c, i) => (
              <li key={i} className={`candidate ${c.status}`}>
                <div className="ctitle">
                  {c.suggestion.title}
                  {c.suggestion.author && (
                    <span className="author"> — {c.suggestion.author}</span>
                  )}
                </div>
                <div className="cstatus">
                  {c.status === 'checking' && (
                    <span className="badge checking">checking PCO…</span>
                  )}
                  {c.status === 'matched' && (
                    <>
                      <span className="badge matched">in library</span>
                      {c.song?.lastScheduledAt ? (
                        <span className="last-played">
                          last played {relativeTime(c.song.lastScheduledAt)}
                        </span>
                      ) : (
                        <span className="last-played">never played</span>
                      )}
                    </>
                  )}
                  {c.status === 'unmatched' && (
                    <span className="badge unmatched">not in library</span>
                  )}
                  {c.status === 'error' && (
                    <span className="badge error" title={c.error}>
                      lookup failed
                    </span>
                  )}
                </div>
                {c.suggestion.reasoning && (
                  <div className="reasoning">{c.suggestion.reasoning}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function updateAt<T>(arr: T[], idx: number, fn: (cur: T) => T): T[] {
  if (!arr[idx]) return arr
  const next = arr.slice()
  next[idx] = fn(next[idx])
  return next
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function pickBestMatch(query: string, songs: Song[]): Song | undefined {
  if (songs.length === 0) return undefined
  const target = normalize(query)
  const exact = songs.find((s) => normalize(s.title) === target)
  if (exact) return exact
  const prefix = songs.find((s) => normalize(s.title).startsWith(target))
  if (prefix) return prefix
  return songs[0]
}

function relativeTime(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24))
  if (days < 1) return 'today'
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  if (days < 365) return `${Math.floor(days / 30)} months ago`
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? '' : 's'} ago`
}
