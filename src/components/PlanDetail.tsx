import { useEffect, useRef, useState } from 'react'
import {
  loadSession,
  saveSession,
  savePlanNotes,
  savePlanTheme,
  searchSongs,
  suggestSongs,
  type AiDebug,
  type Decision,
  type MatchStatus,
  type PersistedCandidate,
  type Plan,
  type PlanItem,
  type PlanNote,
  type SessionMessage,
  type Song,
  type SongSuggestion,
} from '../lib/api'
import { loadPlanContext, patchCachedNotes, patchCachedTheme } from '../lib/cache'
import { isSongSlot } from '../lib/songSlots'
import { praiseChartsSearchUrl, spotifySearchUrl } from '../lib/searchLinks'
import { PromptEditor } from './PromptEditor'

interface CandidateMatch {
  id: string
  suggestion: SongSuggestion
  matchStatus: MatchStatus
  song?: Song
  error?: string
  decision: Decision
  addedAt: number
}

function newCandidateId(): string {
  // crypto.randomUUID is on every modern browser; fall back just in case.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `c_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function toPersisted(c: CandidateMatch): PersistedCandidate {
  return {
    id: c.id,
    title: c.suggestion.title,
    author: c.suggestion.author ?? null,
    reasoning: c.suggestion.reasoning ?? null,
    slots: c.suggestion.slots ?? [],
    matchStatus:
      c.matchStatus === 'checking' ? 'unmatched' : c.matchStatus, // pending lookups are saved as unmatched
    song: c.song
      ? {
          id: c.song.id,
          title: c.song.title,
          lastScheduledAt: c.song.lastScheduledAt,
          lastScheduledShortDates: c.song.lastScheduledShortDates,
        }
      : null,
    error: c.error ?? null,
    decision: c.decision,
    addedAt: c.addedAt,
  }
}

function fromPersisted(p: PersistedCandidate): CandidateMatch {
  return {
    id: p.id,
    suggestion: {
      title: p.title,
      author: p.author ?? undefined,
      reasoning: p.reasoning ?? undefined,
      slots: p.slots,
    },
    matchStatus: p.matchStatus,
    song: p.song
      ? {
          id: p.song.id,
          title: p.song.title,
          author: null,
          ccliNumber: null,
          themes: null,
          isHidden: false,
          lastScheduledAt: p.song.lastScheduledAt,
          lastScheduledShortDates: p.song.lastScheduledShortDates,
        }
      : undefined,
    error: p.error ?? undefined,
    decision: p.decision,
    addedAt: p.addedAt,
  }
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
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [provider, setProvider] = useState<string | null>(null)
  const [debug, setDebug] = useState<AiDebug | null>(null)

  const themeInitialized = useRef(false)
  const notesInitialized = useRef(false)
  const countInitialized = useRef(false)
  // Track whether the user has actually touched the field. We don't want to
  // auto-save the initial seed value (which would treat a never-edited field
  // as a user override, polluting storage).
  const userTouchedTheme = useRef(false)
  const userTouchedNotes = useRef(false)

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
    userTouchedTheme.current = false
    userTouchedNotes.current = false

    setCandidates([])
    setMessages([])
    setSessionLoaded(false)
    setProvider(null)
    setDebug(null)

    // Load the persisted candidate pool + future chat history for this plan.
    // Survives page refreshes and lets iteration span multiple sittings.
    loadSession({ planId })
      .then((res) => {
        if (cancelled) return
        setCandidates(res.data.candidates.map(fromPersisted))
        setMessages(res.data.messages)
        setSessionLoaded(true)
      })
      .catch(() => !cancelled && setSessionLoaded(true))

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

  // Debounced auto-save: persists candidate pool + messages ~700ms after
  // the latest change. Only fires once the session has finished loading
  // so we don't blow away unread state with an empty array.
  useEffect(() => {
    if (!sessionLoaded) return
    const id = setTimeout(() => {
      void saveSession({
        planId,
        session: { candidates: candidates.map(toPersisted), messages },
      }).catch(() => {})
    }, 700)
    return () => clearTimeout(id)
  }, [candidates, messages, sessionLoaded, planId])

  // Debounced auto-save: persists theme/notes ~600ms after the last keystroke.
  // Saving '' when the value matches the PCO source keeps storage tidy (no
  // override = falls back to source on next load).
  useEffect(() => {
    if (!userTouchedTheme.current) return
    const id = setTimeout(() => {
      const value = theme === themeSource ? '' : theme
      patchCachedTheme(serviceTypeId, planId, value)
      void savePlanTheme({ planId, theme: value }).catch(() => {})
    }, 600)
    return () => clearTimeout(id)
  }, [theme, themeSource, serviceTypeId, planId])

  useEffect(() => {
    if (!userTouchedNotes.current) return
    const id = setTimeout(() => {
      const value = notesText === notesSource ? '' : notesText
      patchCachedNotes(serviceTypeId, planId, value)
      void savePlanNotes({ planId, notes: value }).catch(() => {})
    }, 600)
    return () => clearTimeout(id)
  }, [notesText, notesSource, serviceTypeId, planId])

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
      // re-suggest what's already filled in. Rejected candidates are
      // explicitly fed back so the model knows we said "not that one".
      const rejected = candidates.filter((c) => c.decision === 'reject')
      const exclude = [
        ...candidates.map((c) => c.suggestion.title),
        ...(items ?? [])
          .filter((it) => it.songId && it.songTitle)
          .map((it) => it.songTitle!),
      ]
      const serviceOrder = buildServiceOrderText(items)
      const res = await suggestSongs({
        theme,
        criteria: criteria + (rejected.length > 0
          ? `\n\nAvoid suggestions similar to these (the user already rejected them): ${rejected.map((c) => c.suggestion.title).join(', ')}`
          : ''),
        exclude,
        count,
        planId,
        serviceOrder,
        planNotes: notesText,
      })
      setProvider(res.data.provider)
      setDebug(res.data.debug ?? null)

      const now = Date.now()
      const newOnes: CandidateMatch[] = res.data.suggestions.map((s) => ({
        id: newCandidateId(),
        suggestion: s,
        matchStatus: 'checking',
        decision: 'pending',
        addedAt: now,
      }))
      setCandidates((prev) => [...prev, ...newOnes])

      newOnes.forEach((c) => {
        searchSongs({ query: c.suggestion.title })
          .then((sr) => {
            const match = sr.data.songs[0]
            setCandidates((prev) =>
              prev.map((cur) =>
                cur.id === c.id
                  ? match
                    ? { ...cur, matchStatus: 'matched', song: match }
                    : { ...cur, matchStatus: 'unmatched' }
                  : cur,
              ),
            )
          })
          .catch((e: Error) => {
            setCandidates((prev) =>
              prev.map((cur) =>
                cur.id === c.id
                  ? { ...cur, matchStatus: 'error', error: e.message }
                  : cur,
              ),
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
    setMessages([])
    setDebug(null)
  }

  function setDecision(id: string, next: Decision) {
    setCandidates((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, decision: c.decision === next ? 'pending' : next }
          : c,
      ),
    )
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
              const showMeta =
                filled &&
                (it.keyName ||
                  it.description ||
                  it.notes.length > 0 ||
                  it.leaders.length > 0)
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
                    {showMeta && (
                      <div className="item-meta">
                        <div className="meta-chips">
                          {it.keyName && (
                            <span className="meta-chip">
                              Key <strong>{it.keyName}</strong>
                            </span>
                          )}
                          {it.leaders.map((leader, i) => (
                            <span key={i} className="meta-chip leader-chip">
                              <span className="leader-icon" aria-hidden>
                                ♪
                              </span>
                              {leader}
                            </span>
                          ))}
                        </div>
                        {it.description && (
                          <div className="meta-text">{it.description}</div>
                        )}
                        {it.notes.map((n, i) => (
                          <div key={i} className="meta-note">
                            {n.content}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {filled && displayTitle && (
                    <a
                      className="spotify-link"
                      href={spotifySearchUrl(displayTitle)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Search Spotify"
                    >
                      Spotify ↗
                    </a>
                  )}
                </li>
              )
            })}
          </ol>
        </section>
      )}

      <div className="prompt-editors">
        <PromptEditor type="role" planId={planId} />
        <PromptEditor type="structure" planId={planId} />
      </div>

      <section className="criteria">
        <h3>Suggest songs</h3>
        <label>
          <span className="theme-label">
            <span>
              Theme <span className="source-hint">· from Planning Center title</span>
            </span>
            <span
              className="ai-context-marker"
              title="Sent to the AI on every Suggest call"
              aria-hidden
            >
              ✨
            </span>
            {theme.trim() !== themeSource.trim() && (
              <>
                <span
                  className="edited-flag"
                  title={`Differs from Planning Center: "${themeSource || '(empty)'}"`}
                >
                  edited
                </span>
                <button
                  type="button"
                  className="reset-btn"
                  onClick={() => {
                    setTheme(themeSource)
                    patchCachedTheme(serviceTypeId, planId, '')
                    void savePlanTheme({ planId, theme: '' }).catch(() => {})
                  }}
                  title="Reset to the Planning Center value (clears your saved override)"
                >
                  ↺ reset
                </button>
              </>
            )}
          </span>
          <input
            type="text"
            value={theme}
            onChange={(e) => {
              userTouchedTheme.current = true
              setTheme(e.target.value)
            }}
            placeholder="What is the service about?"
          />
        </label>
        <label>
          <span className="theme-label">
            <span>
              Context{' '}
              <span className="source-hint">· from Planning Center service notes</span>
            </span>
            <span
              className="ai-context-marker"
              title="Sent to the AI on every Suggest call"
              aria-hidden
            >
              ✨
            </span>
            {notesText.trim() !== notesSource.trim() && (
              <>
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
                <button
                  type="button"
                  className="reset-btn"
                  onClick={() => {
                    setNotesText(notesSource)
                    patchCachedNotes(serviceTypeId, planId, '')
                    void savePlanNotes({ planId, notes: '' }).catch(() => {})
                  }}
                  title="Reset to the Planning Center value (clears your saved override)"
                >
                  ↺ reset
                </button>
              </>
            )}
          </span>
          <textarea
            rows={Math.min(8, Math.max(3, notesText.split('\n').length + 1))}
            value={notesText}
            onChange={(e) => {
              userTouchedNotes.current = true
              setNotesText(e.target.value)
            }}
            placeholder="Sermon theme, scripture, anything else worth flagging to the AI."
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
            {candidates.map((c) => {
              const matched = c.matchStatus === 'matched' && c.song
              return (
                <li
                  key={c.id}
                  className={`candidate match-${c.matchStatus} decision-${c.decision}`}
                >
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
                    {c.matchStatus === 'checking' && (
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
                    {c.matchStatus === 'unmatched' && (
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
                    {c.matchStatus === 'error' && (
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
                  <div className="decision-row">
                    <button
                      type="button"
                      className={`decision-btn decision-shortlist${c.decision === 'shortlist' ? ' on' : ''}`}
                      onClick={() => setDecision(c.id, 'shortlist')}
                      title={
                        c.decision === 'shortlist'
                          ? 'Click again to undo'
                          : 'Shortlist this song'
                      }
                    >
                      ✓ Shortlist
                    </button>
                    <button
                      type="button"
                      className={`decision-btn decision-reject${c.decision === 'reject' ? ' on' : ''}`}
                      onClick={() => setDecision(c.id, 'reject')}
                      title={
                        c.decision === 'reject'
                          ? 'Click again to undo'
                          : 'Reject this song'
                      }
                    >
                      ✗ Reject
                    </button>
                  </div>
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


// Render Planning Center plan notes as the editable seed text. Plain
// newline-separated note content — no category labels (noise) and no
// bullet markers (awkward for single notes, the AI handles either way).
function formatNotesSource(notes: PlanNote[] | null): string {
  if (!notes || notes.length === 0) return ''
  return notes
    .filter((n) => n.content && n.content.trim())
    .map((n) => n.content.trim())
    .join('\n\n')
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
