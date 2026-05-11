import { useEffect, useRef, useState } from 'react'
import {
  savePlanNotes,
  savePlanTheme,
  searchSongs,
  suggestSongs,
  type AiDebug,
  type Plan,
  type PlanItem,
  type PlanNote,
  type Song,
  type SongSuggestion,
} from '../lib/api'
import { loadPlanContext, patchCachedNotes, patchCachedTheme } from '../lib/cache'
import { isSongSlot } from '../lib/songSlots'
import { praiseChartsSearchUrl, spotifySearchUrl } from '../lib/searchLinks'
import { PromptEditor } from './PromptEditor'

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
  const [themeSource, setThemeSource] = useState('')
  const [notesText, setNotesText] = useState('')
  const [notesSource, setNotesSource] = useState('')
  const [criteria, setCriteria] = useState('')
  const [count, setCount] = useState(5)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<CandidateMatch[]>([])
  const [provider, setProvider] = useState<string | null>(null)
  const [debug, setDebug] = useState<AiDebug | null>(null)

  const themeInitialized = useRef(false)
  const notesInitialized = useRef(false)
  const countInitialized = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    setPlan(null)
    setNotes(null)
    setItems(null)
    setThemeSource('')
    setNotesSource('')
    themeInitialized.current = false
    notesInitialized.current = false
    countInitialized.current = false

    loadPlanContext(serviceTypeId, planId)
      .then((ctx) => {
        if (cancelled) return
        setPlan(ctx.plan)
        setNotes(ctx.notes)
        setItems(ctx.items)
        const themeSrc = ctx.plan.seriesTitle ?? ctx.plan.title ?? ''
        setThemeSource(themeSrc)
        const notesSrc = formatNotesSource(ctx.notes)
        setNotesSource(notesSrc)
        if (!themeInitialized.current) {
          const saved = ctx.userTheme
          setTheme(saved && saved.trim() ? saved : themeSrc)
          themeInitialized.current = true
        }
        if (!notesInitialized.current) {
          const saved = ctx.userNotes
          setNotesText(saved && saved.trim() ? saved : notesSrc)
          notesInitialized.current = true
        }
        if (!countInitialized.current) {
          const songSlotCount = ctx.items.filter(isSongSlot).length
          setCount(Math.max(songSlotCount * 2, 5))
          countInitialized.current = true
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
      // Persist user edits so future visits to this plan start with what
      // they typed rather than re-defaulting from PCO. Best-effort — a
      // save failure doesn't block the suggest. Patch the SPA cache too
      // so a back-and-return doesn't show stale.
      patchCachedTheme(serviceTypeId, planId, theme)
      void savePlanTheme({ planId, theme }).catch(() => {})
      patchCachedNotes(serviceTypeId, planId, notesText)
      void savePlanNotes({ planId, notes: notesText }).catch(() => {})

      // Also exclude already-picked songs in the plan so the AI doesn't
      // re-suggest what's already filled in.
      const exclude = [
        ...candidates.map((c) => c.suggestion.title),
        ...(items ?? [])
          .filter((it) => it.songId && it.songTitle)
          .map((it) => it.songTitle!),
      ]
      const serviceOrder = buildServiceOrderText(items)
      const res = await suggestSongs({
        theme,
        criteria,
        exclude,
        count,
        planId,
        serviceOrder,
        planNotes: notesText,
      })
      setProvider(res.data.provider)
      setDebug(res.data.debug ?? null)

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
            // searchSongs Cloud Function uses PCO's case-insensitive exact
            // title match (with a parenthetical-stripped retry), so 0 or 1
            // result; first wins if more.
            const match = sr.data.songs[0]
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
    setDebug(null)
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

      <div className="title-row">
        <h2>{plan.title || plan.seriesTitle || '(no title)'}</h2>
        <a
          className="pco-link"
          href={`https://services.planningcenteronline.com/plans/${plan.id}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in Planning Center"
        >
          Open in Planning Center ↗
        </a>
      </div>
      <div className="meta">
        {subtitle && <span>{subtitle} · </span>}
        {plan.sortDate &&
          new Date(plan.sortDate).toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
        {(() => {
          const leaders =
            plan.teamMembers?.filter((m) => m.position === 'Worship Leader') ?? []
          return leaders.length > 0 ? (
            <> · led by {leaders.map((l) => l.name).join(', ')}</>
          ) : null
        })()}
      </div>

      {items.length > 0 && (
        <section className="service-order">
          <h3>
            Service order
            <span
              className="ai-context-marker"
              title="The service order — including which songs are already picked — is part of the context sent to the AI"
              aria-hidden
            >
              ✨
            </span>
          </h3>
          <ol>
            {items.map((it) => {
              // Filled = linked to a real song; isSong from shared helper so
              // the list-view badge and detail-view styling agree.
              const filled = it.songId != null
              const isSong = isSongSlot(it)
              const cls = `item type-${it.itemType}${
                isSong ? (filled ? ' song-filled' : ' song-empty-slot') : ''
              }`
              const displayTitle = it.title || it.songTitle || ''
              return (
                <li key={it.id} className={cls}>
                  <span className="seq">{it.sequence}</span>
                  <div className="ibody">
                    {filled ? (
                      <a
                        className="ititle ititle-link"
                        href={`https://services.planningcenteronline.com/songs/${it.songId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open song in Planning Center"
                      >
                        {displayTitle || '(song)'} ↗
                      </a>
                    ) : (
                      <div className="ititle">{it.title || '(no title)'}</div>
                    )}
                    {isSong && !filled && (
                      <span className="song-empty">Pick a song</span>
                    )}
                  </div>
                  {filled && displayTitle ? (
                    <a
                      className="spotify-link"
                      href={spotifySearchUrl(displayTitle)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Search Spotify"
                    >
                      Spotify ↗
                    </a>
                  ) : (
                    !isSong && (
                      <span className={`badge type-${it.itemType}`}>{it.itemType}</span>
                    )
                  )}
                </li>
              )
            })}
          </ol>
        </section>
      )}

      <section className="notes">
        <h3>
          Plan context
          <span
            className="ai-context-marker"
            title="Sent to the AI on every Suggest call"
            aria-hidden
          >
            ✨
          </span>
          {notesText.trim() !== notesSource.trim() && (
            <span
              className="edited-flag"
              title={
                notesSource
                  ? `Differs from Planning Center notes:\n${notesSource}`
                  : 'No notes set in Planning Center'
              }
            >
              edited
            </span>
          )}
        </h3>
        <textarea
          className="notes-editor"
          value={notesText}
          onChange={(e) => setNotesText(e.target.value)}
          rows={Math.min(8, Math.max(3, notesText.split('\n').length + 1))}
          placeholder="Sermon theme, scripture, anything else worth flagging to the AI."
        />
      </section>

      <div className="prompt-editors">
        <PromptEditor type="role" planId={planId} />
        <PromptEditor type="structure" planId={planId} />
      </div>

      <section className="criteria">
        <h3>Suggest songs</h3>
        <label>
          <span className="theme-label">
            Theme
            <span
              className="ai-context-marker"
              title="Sent to the AI on every Suggest call"
              aria-hidden
            >
              ✨
            </span>
            {theme.trim() !== themeSource.trim() && (
              <span
                className="edited-flag"
                title={`Differs from Planning Center: "${themeSource || '(empty)'}"`}
              >
                edited
              </span>
            )}
          </span>
          <input
            type="text"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder="What is the service about?"
          />
        </label>
        <label>
          <span>
            Criteria (mood, tempo, era, must-include, avoid)
            <span
              className="ai-context-marker"
              title="Sent to the AI on every Suggest call"
              aria-hidden
            >
              ✨
            </span>
          </span>
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
          <button
            className="ai-button"
            onClick={handleSuggest}
            disabled={generating || !theme.trim()}
          >
            <span className="sparkle" aria-hidden>✨</span>
            {generating
              ? 'Generating…'
              : candidates.length > 0
                ? 'Suggest more'
                : 'Suggest songs'}
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
          <h3 className="ai-heading">
            <span className="sparkle" aria-hidden>✨</span>
            <span className="gradient-text">
              AI candidates ({candidates.length})
            </span>
            {provider && <span className="provider-tag">via {providerLabel(provider)}</span>}
          </h3>
          <ul>
            {candidates.map((c, i) => {
              const matched = c.status === 'matched' && c.song
              return (
                <li key={i} className={`candidate ${c.status}`}>
                  <div className="ctitle">
                    {matched ? (
                      <a
                        className="ctitle-link"
                        href={`https://services.planningcenteronline.com/songs/${c.song!.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open in Planning Center"
                      >
                        {c.suggestion.title} ↗
                      </a>
                    ) : (
                      c.suggestion.title
                    )}
                    {c.suggestion.author && (
                      <span className="author"> — {c.suggestion.author}</span>
                    )}
                  </div>
                  {c.suggestion.slots && c.suggestion.slots.length > 0 && (
                    <div className="slot-tags">
                      {c.suggestion.slots.map((s, si) => (
                        <span key={si} className="slot-tag">
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="cstatus">
                    {c.status === 'checking' && (
                      <span className="badge checking">checking library…</span>
                    )}
                    {matched && (
                      <>
                        <span className="badge matched">in library</span>
                        {c.song!.lastScheduledAt ? (
                          <span
                            className="last-played"
                            title={new Date(c.song!.lastScheduledAt).toLocaleString()}
                          >
                            last played {relativeTime(c.song!.lastScheduledAt)}
                            {c.song!.lastScheduledShortDates && (
                              <> · {c.song!.lastScheduledShortDates}</>
                            )}
                          </span>
                        ) : (
                          <span className="last-played">never played</span>
                        )}
                      </>
                    )}
                    {c.status === 'unmatched' && (
                      <>
                        <span className="badge unmatched">not in library</span>
                        <a
                          className="chart-search-link"
                          href={praiseChartsSearchUrl(c.suggestion.title)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Search PraiseCharts for a chord chart"
                        >
                          Find chart ↗
                        </a>
                      </>
                    )}
                    {c.status === 'error' && (
                      <span className="badge error" title={c.error}>
                        lookup failed
                      </span>
                    )}
                    <a
                      className="spotify-link"
                      href={spotifySearchUrl(c.suggestion.title)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Search Spotify"
                    >
                      Spotify ↗
                    </a>
                  </div>
                  {c.suggestion.reasoning && (
                    <div className="reasoning">
                      <span className="sparkle-prefix" aria-hidden>✨</span>
                      <span>{c.suggestion.reasoning}</span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {debug && (
            <details className="ai-debug">
              <summary>
                <span className="chevron" aria-hidden>▸</span>
                <span>Context sent to AI</span>
              </summary>
              <div className="debug-body">
                <div className="debug-row">
                  <span className="debug-label">Model</span>
                  <code>{debug.model}</code>
                </div>
                <div className="debug-row">
                  <span className="debug-label">System prompt</span>
                  <pre>{debug.systemPrompt}</pre>
                </div>
                <div className="debug-row">
                  <span className="debug-label">User message</span>
                  <pre>{debug.userMessage}</pre>
                </div>
              </div>
            </details>
          )}
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

// Render Planning Center plan notes as the editable seed text. Same shape
// the AI eventually receives — bullet list with category prefixes — so
// the source-of-truth comparison for the "edited" flag is meaningful.
function formatNotesSource(notes: PlanNote[] | null): string {
  if (!notes || notes.length === 0) return ''
  return notes
    .filter((n) => n.content && n.content.trim())
    .map((n) => `- ${n.category ? `${n.category}: ` : ''}${n.content.trim()}`)
    .join('\n')
}

// Render the plan's items as a human-readable list for the AI prompt.
// Empty song slots get an explicit "(empty — needs a pick)" marker so the
// model can see exactly which positions in the order need filling.
function buildServiceOrderText(items: PlanItem[] | null): string {
  if (!items || items.length === 0) return ''
  return items
    .map((it) => {
      const songSlot = isSongSlot(it)
      const base = `${it.sequence}. ${it.title || '(no title)'}`
      if (!songSlot) return base
      if (it.songId) {
        return `${base} — picked: ${it.songTitle ?? '(song)'}`
      }
      return `${base} — (empty, needs a pick)`
    })
    .join('\n')
}

function providerLabel(name: string): string {
  switch (name) {
    case 'anthropic':
      return 'Claude Sonnet 4.6'
    case 'gemini':
      return 'Gemini 2.5 Flash'
    case 'openai':
      return 'GPT-4o'
    default:
      return name
  }
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
