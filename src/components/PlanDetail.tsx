import { useEffect, useRef, useState } from 'react'
import {
  commitSlot,
  loadSession,
  saveSession,
  savePlanNotes,
  savePlanTheme,
  searchSongs,
  suggestSongs,
  type AiDebug,
  type ConversationTurn,
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
import {
  invalidatePlanContext,
  loadPlanContext,
  patchCachedNotes,
  patchCachedTheme,
} from '../lib/cache'
import { isSongSlot } from '../lib/songSlots'
import { praiseChartsSearchUrl, spotifySearchUrl } from '../lib/searchLinks'
import { usePromptConfig } from '../lib/usePromptConfig'
import { PromptBody } from './PromptBody'
import { PromptPill } from './PromptPill'

type OpenPrompt = 'role' | 'structure' | null

const PROMPT_COPY = {
  role: {
    label: 'AI persona',
    help: "Describe the AI's persona — who it is, how it should think about your service, the kind of church you lead, the theological frame you prefer, etc. The technical JSON-format requirements are added behind the scenes, so you can edit freely without breaking output.",
  },
  structure: {
    label: 'AI service-flow prompt',
    help: 'Extra context the AI receives on every Suggest call, shaping how songs are distributed across the service (opener, mid-service, closer, etc.).',
  },
}

interface CandidateMatch {
  id: string
  suggestion: SongSuggestion
  matchStatus: MatchStatus
  song?: Song
  error?: string
  decision: Decision
  addedAt: number
  assignedSlotItemId: string | null
  committedAt: number | null
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
    chorusSnippet: c.suggestion.chorusSnippet ?? null,
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
    assignedSlotItemId: c.assignedSlotItemId,
    committedAt: c.committedAt,
  }
}

function fromPersisted(p: PersistedCandidate): CandidateMatch {
  return {
    id: p.id,
    suggestion: {
      title: p.title,
      author: p.author ?? undefined,
      chorusSnippet: p.chorusSnippet ?? undefined,
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
    assignedSlotItemId: p.assignedSlotItemId,
    committedAt: p.committedAt,
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

  const roleHook = usePromptConfig('role', planId)
  const structureHook = usePromptConfig('structure', planId)
  const [openPrompt, setOpenPrompt] = useState<OpenPrompt>(null)
  function togglePrompt(which: 'role' | 'structure') {
    setOpenPrompt((prev) => (prev === which ? null : which))
  }
  // Track whether the user has actually touched the field. We don't want to
  // auto-save the initial seed value (which would treat a never-edited field
  // as a user override, polluting storage).
  const userTouchedTheme = useRef(false)
  const userTouchedNotes = useRef(false)
  // Debounced auto-replacement after Reject clicks. Rejecting multiple
  // candidates in quick succession coalesces into a single call for N
  // replacements rather than N independent calls.
  const replacementTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingReplacements = useRef(0)

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

  // Core suggestion fetcher used by both the user-driven Suggest button and
  // the silent auto-replacement after rejections. The `addToChat` flag
  // splits the two behaviours: user-driven calls record a chat turn and
  // surface the spinner / errors; auto-replacements run quietly in the
  // background.
  async function fetchSuggestions(opts: {
    count: number
    userMessage: string
    addToChat: boolean
  }) {
    if (!theme.trim()) return
    if (opts.addToChat) {
      setGenerating(true)
      setGenerateError(null)
      patchCachedTheme(serviceTypeId, planId, theme)
      void savePlanTheme({ planId, theme }).catch(() => {})
      patchCachedNotes(serviceTypeId, planId, notesText)
      void savePlanNotes({ planId, notes: notesText }).catch(() => {})
    }
    try {
      const exclude = [
        ...candidates.map((c) => c.suggestion.title),
        ...(items ?? [])
          .filter((it) => it.songId && it.songTitle)
          .map((it) => it.songTitle!),
      ]
      const shortlistedTitles = candidates
        .filter((c) => c.decision === 'shortlist')
        .map((c) => c.suggestion.title)
      const rejectedTitles = candidates
        .filter((c) => c.decision === 'reject')
        .map((c) => c.suggestion.title)
      const serviceOrder = buildServiceOrderText(items)
      // System messages live in the chat log for the user's benefit
      // (reject/unreject/commit/auto-replace markers) — they're not
      // sent to the model. AI decisions already get the structured
      // shortlisted/rejected state on every call.
      const history = messages
        .filter((m): m is SessionMessage & { role: 'user' | 'assistant' } =>
          m.role !== 'system',
        )
        .map((m) => ({ role: m.role, content: m.content }))

      const res = await suggestSongs({
        theme,
        userMessage: opts.userMessage,
        exclude,
        count: opts.count,
        planId,
        serviceOrder,
        planNotes: notesText,
        history: history as ConversationTurn[],
        shortlistedTitles,
        rejectedTitles,
      })

      if (opts.addToChat) {
        setProvider(res.data.provider)
        setDebug(res.data.debug ?? null)
        const turnTs = Date.now()
        setMessages((prev) => [
          ...prev,
          {
            id: newCandidateId(),
            role: 'user',
            content: opts.userMessage.trim() || '(initial request)',
            timestamp: turnTs,
          },
          {
            id: newCandidateId(),
            role: 'assistant',
            content: res.data.assistantMessage,
            timestamp: turnTs + 1,
          },
        ])
        // Clear the input for the next refinement.
        setCriteria('')
      }

      // The "at least 4 per slot" rule in the technical requirements makes
      // the model over-deliver — for chat-driven calls that's the point,
      // but for silent auto-replacements (1:1 with rejections) it's
      // clutter. Hard-cap silent calls to the requested count.
      const accepted = opts.addToChat
        ? res.data.suggestions
        : res.data.suggestions.slice(0, opts.count)

      const now = Date.now()
      const newOnes: CandidateMatch[] = accepted.map((s) => ({
        id: newCandidateId(),
        suggestion: s,
        matchStatus: 'checking',
        decision: 'pending',
        addedAt: now,
        assignedSlotItemId: null,
        committedAt: null,
      }))
      setCandidates((prev) => [...prev, ...newOnes])

      // Surface silent auto-replacements in the chat log so the user can
      // see what the AI swapped in without it feeling magical/silent.
      if (!opts.addToChat && accepted.length > 0) {
        const titles = accepted.map((s) => s.title).join(', ')
        appendSystemMessage(
          `↻ Replaced rejected song${accepted.length === 1 ? '' : 's'} with: ${titles}`,
        )
      }

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
      if (opts.addToChat) {
        setGenerateError((e as Error).message)
      } else {
        // Silent failures for auto-replacement — user didn't ask, don't
        // interrupt their flow. Worth logging for debugging.
        console.warn('[songpicker] auto-replacement failed:', e)
      }
    } finally {
      if (opts.addToChat) setGenerating(false)
    }
  }

  async function handleSuggest() {
    if (!theme.trim() || generating) return
    await fetchSuggestions({
      count,
      userMessage: criteria,
      addToChat: true,
    })
  }

  function scheduleReplacement() {
    pendingReplacements.current += 1
    if (replacementTimer.current) clearTimeout(replacementTimer.current)
    replacementTimer.current = setTimeout(() => {
      const n = pendingReplacements.current
      pendingReplacements.current = 0
      replacementTimer.current = null
      if (n <= 0) return
      void fetchSuggestions({
        count: n,
        userMessage: `(auto-replacement for ${n} rejected song${n === 1 ? '' : 's'})`,
        addToChat: false,
      })
    }, 600)
  }

  function clearCandidates() {
    setCandidates([])
    setMessages([])
    setDebug(null)
  }

  function appendSystemMessage(content: string) {
    setMessages((prev) => [
      ...prev,
      {
        id: newCandidateId(),
        role: 'system',
        content,
        timestamp: Date.now(),
      },
    ])
  }

  function setDecision(id: string, next: Decision) {
    const target = candidates.find((c) => c.id === id)
    if (!target) return
    const oldDecision = target.decision
    const newDecision: Decision = oldDecision === next ? 'pending' : next

    setCandidates((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        // Drop any pending assignment when leaving shortlist (committed
        // assignments survive — that history is real).
        const clearAssignment = newDecision !== 'shortlist' && !c.committedAt
        return {
          ...c,
          decision: newDecision,
          assignedSlotItemId: clearAssignment ? null : c.assignedSlotItemId,
        }
      }),
    )

    // Surface decision changes in the chat log so the conversation
    // captures everything that shapes future suggestions, not just
    // typed refinements.
    if (newDecision === 'reject' && oldDecision !== 'reject') {
      appendSystemMessage(`✗ Rejected: ${target.suggestion.title}`)
      // Newly rejected → schedule a replacement so the pool stays the
      // same effective size.
      scheduleReplacement()
    } else if (oldDecision === 'reject' && newDecision !== 'reject') {
      appendSystemMessage(`↩ Unrejected: ${target.suggestion.title}`)
    }
  }

  function assignSlot(candidateId: string, slotItemId: string | null) {
    setCandidates((prev) =>
      prev.map((c) =>
        c.id === candidateId && !c.committedAt
          ? { ...c, assignedSlotItemId: slotItemId }
          : c,
      ),
    )
  }

  async function commitCandidate(c: CandidateMatch) {
    if (!c.assignedSlotItemId || !c.song || c.committedAt) return
    const slot = (items ?? []).find((it) => it.id === c.assignedSlotItemId)
    try {
      await commitSlot({
        serviceTypeId,
        planId,
        itemId: c.assignedSlotItemId,
        songId: c.song.id,
      })
      setCandidates((prev) =>
        prev.map((x) =>
          x.id === c.id ? { ...x, committedAt: Date.now() } : x,
        ),
      )
      appendSystemMessage(
        `↗ Committed “${c.suggestion.title}” → ${slot?.title ?? 'slot'}`,
      )
      // Refresh service order so the slot flips from empty to filled.
      invalidatePlanContext(serviceTypeId, planId)
      const fresh = await loadPlanContext(serviceTypeId, planId)
      setItems(fresh.items)
    } catch (e) {
      setGenerateError((e as Error).message)
    }
  }

  if (loadError) return <div className="error">Error loading plan: {loadError}</div>
  if (!plan || !notes || !items) return <div>Loading plan…</div>

  const subtitle = plan.title && plan.seriesTitle ? plan.seriesTitle : null

  return (
    <div className="plan-detail">
      <div className="plan-header">
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
          <span className="meta-text">
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
          </span>
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
      </div>

      <div className="plan-body">
        <div className="plan-left">
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
                  it.leaders.length > 0 ||
                  it.songAuthor ||
                  it.songCcli)
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
                        {(it.songAuthor || it.songCcli) && (
                          <div className="meta-credits">
                            {it.songAuthor && (
                              <span>by <strong>{it.songAuthor}</strong></span>
                            )}
                            {it.songCcli && (
                              <span> · CCLI {it.songCcli}</span>
                            )}
                          </div>
                        )}
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

      <section className="suggest-section">
        <div className="suggest-section-header">
          <h3>Suggest songs</h3>
          <div className="prompt-pills">
            <PromptPill
              type="role"
              label={PROMPT_COPY.role.label}
              source={roleHook.config?.effective.source ?? 'system'}
              isOpen={openPrompt === 'role'}
              onToggle={() => togglePrompt('role')}
            />
            <PromptPill
              type="structure"
              label={PROMPT_COPY.structure.label}
              source={structureHook.config?.effective.source ?? 'system'}
              isOpen={openPrompt === 'structure'}
              onToggle={() => togglePrompt('structure')}
            />
          </div>
        </div>
        {openPrompt === 'role' && (
          <PromptBody
            label={PROMPT_COPY.role.label}
            help={PROMPT_COPY.role.help}
            hook={roleHook}
          />
        )}
        {openPrompt === 'structure' && (
          <PromptBody
            label={PROMPT_COPY.structure.label}
            help={PROMPT_COPY.structure.help}
            hook={structureHook}
          />
        )}
        <div className="suggest-form">
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
        {messages.length > 0 && (
          <div className="chat-log">
            {messages.map((m) => {
              if (m.role === 'system') {
                return (
                  <div key={m.id} className="chat-msg chat-msg-system">
                    {m.content}
                  </div>
                )
              }
              return (
                <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
                  <span className="chat-role">
                    {m.role === 'user' ? (
                      'You'
                    ) : (
                      <>
                        <span className="sparkle" aria-hidden>✨</span> AI
                      </>
                    )}
                  </span>
                  <div className="chat-content">{m.content}</div>
                </div>
              )
            })}
          </div>
        )}
        <label>
          <span>
            {messages.length === 0
              ? 'Criteria (mood, tempo, era, must-include, avoid)'
              : 'Refine'}
            <span
              className="ai-context-marker"
              title="Sent to the AI on the next Suggest call"
              aria-hidden
            >
              ✨
            </span>
          </span>
          <textarea
            rows={messages.length === 0 ? 4 : 2}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder={
              messages.length === 0
                ? "e.g. upbeat opener, slower communion song, include 'Cornerstone'"
                : "e.g. give me a few more upbeat openers, or swap the closer for something slower"
            }
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
              : messages.length === 0
                ? 'Suggest songs'
                : 'Send refinement'}
          </button>
          {candidates.length > 0 && (
            <button className="ghost" onClick={clearCandidates} disabled={generating}>
              Clear
            </button>
          )}
        </div>
        {generateError && <div className="error">Error: {generateError}</div>}
        </div>
      </section>

      {(() => {
        const rejected = candidates.filter((c) => c.decision === 'reject')
        if (rejected.length === 0) return null
        return (
          <details className="rejected-pool">
            <summary>
              <span className="chevron" aria-hidden>▸</span>
              <span>{rejected.length} rejected</span>
            </summary>
            <ul className="rejected-list">
              {rejected.map((c) => (
                <li key={c.id} className="rejected-card">
                  <div className="rejected-title">
                    {c.suggestion.title}
                    {c.suggestion.author && (
                      <span className="author"> — {c.suggestion.author}</span>
                    )}
                  </div>
                  {c.suggestion.chorusSnippet && (
                    <div className="rejected-snippet">
                      “{c.suggestion.chorusSnippet}”
                    </div>
                  )}
                  <button
                    type="button"
                    className="decision-btn"
                    onClick={() => setDecision(c.id, 'reject')}
                    title="Bring this candidate back to the active pool"
                  >
                    ↶ Unreject
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )
      })()}

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
        </div>

        <div className="plan-right">
      {candidates.length > 0 && (() => {
        // Active = pending or shortlisted; rejected ones get tucked into
        // a collapsed disclosure on the left column to reduce clutter.
        const active = candidates.filter((c) => c.decision !== 'reject')
        // Empty song slots currently free in PCO. We assign by the slot's
        // item id; the dropdown on each candidate filters out slots
        // already claimed by another (uncommitted) candidate so two
        // candidates can't queue for the same slot.
        const emptySongSlots = (items ?? []).filter(
          (it) => isSongSlot(it) && !it.songId,
        )
        const slotById = new Map(emptySongSlots.map((s) => [s.id, s] as const))

        function availableSlotsFor(candidateId: string): PlanItem[] {
          const takenByOthers = new Set(
            candidates
              .filter(
                (c) =>
                  c.id !== candidateId &&
                  c.assignedSlotItemId &&
                  !c.committedAt,
              )
              .map((c) => c.assignedSlotItemId!),
          )
          return emptySongSlots.filter((s) => !takenByOthers.has(s.id))
        }

        if (active.length === 0) return null
        return (
        <section className="candidates">
          <h3 className="ai-heading">
            <span className="sparkle" aria-hidden>✨</span>
            <span className="gradient-text">
              AI candidates ({active.length})
            </span>
            {provider && <span className="provider-tag">via {providerLabel(provider)}</span>}
          </h3>
          <ul>
            {active.map((c) => {
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
                        {c.song!.ccliNumber && (
                          <span className="last-played" title="CCLI number">
                            · CCLI {c.song!.ccliNumber}
                          </span>
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
                  {c.suggestion.chorusSnippet && (
                    <div className="chorus-snippet">
                      <span className="snippet-quote" aria-hidden>“</span>
                      {c.suggestion.chorusSnippet}
                      <span className="snippet-quote" aria-hidden>”</span>
                    </div>
                  )}
                  <div className="decision-row">
                    <button
                      type="button"
                      className={`decision-btn decision-shortlist${c.decision === 'shortlist' ? ' on' : ''}`}
                      onClick={() => setDecision(c.id, 'shortlist')}
                      disabled={!!c.committedAt}
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
                      disabled={!!c.committedAt}
                      title={
                        c.decision === 'reject'
                          ? 'Click again to undo'
                          : 'Reject this song'
                      }
                    >
                      ✗ Reject
                    </button>

                    {c.decision === 'shortlist' && matched && (() => {
                      if (c.committedAt) {
                        const slot = c.assignedSlotItemId
                          ? slotById.get(c.assignedSlotItemId)
                          : null
                        return (
                          <span className="committed-badge">
                            ✓ Committed{slot ? ` to ${slot.title}` : ''}
                          </span>
                        )
                      }
                      if (c.assignedSlotItemId) {
                        const slot = slotById.get(c.assignedSlotItemId)
                        return (
                          <>
                            <span className="assigned-arrow">
                              → {slot?.title ?? '(slot)'}
                            </span>
                            <button
                              type="button"
                              className="commit-btn"
                              onClick={() => commitCandidate(c)}
                              title="Push this song into the slot in Planning Center"
                            >
                              ↗ Commit
                            </button>
                            <button
                              type="button"
                              className="unassign-btn"
                              onClick={() => assignSlot(c.id, null)}
                              title="Unassign"
                            >
                              ×
                            </button>
                          </>
                        )
                      }
                      const avail = availableSlotsFor(c.id)
                      return (
                        <select
                          className="slot-picker"
                          value=""
                          disabled={avail.length === 0}
                          onChange={(e) =>
                            e.target.value && assignSlot(c.id, e.target.value)
                          }
                          title={
                            avail.length === 0
                              ? 'No empty song slots available'
                              : 'Assign to slot'
                          }
                        >
                          <option value="">
                            {avail.length === 0
                              ? 'No open slots'
                              : 'Assign to slot…'}
                          </option>
                          {avail.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.title}
                            </option>
                          ))}
                        </select>
                      )
                    })()}
                  </div>
                </li>
              )
            })}
          </ul>
          {/* end candidates list */}
        </section>
        )
      })()}
        </div>
      </div>
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
// model can see exactly which positions in the order need filling. Filled
// song slots include author + CCLI + arrangement when available to
// disambiguate same-titled songs (multiple "Surrender"s exist).
function buildServiceOrderText(items: PlanItem[] | null): string {
  if (!items || items.length === 0) return ''
  return items
    .map((it) => {
      const songSlot = isSongSlot(it)
      const base = `${it.sequence}. ${it.title || '(no title)'}`
      if (!songSlot) return base
      if (it.songId) {
        const disamb = formatSongDisamb(it)
        return `${base} — picked: ${it.songTitle ?? '(song)'}${disamb ? ` ${disamb}` : ''}`
      }
      return `${base} — (empty, needs a pick)`
    })
    .join('\n')
}

function formatSongDisamb(it: PlanItem): string {
  const parts: string[] = []
  if (it.songAuthor) parts.push(`by ${it.songAuthor}`)
  if (it.songCcli) parts.push(`CCLI ${it.songCcli}`)
  return parts.length > 0 ? `(${parts.join(', ')})` : ''
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
