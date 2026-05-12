import React, { useEffect, useRef, useState } from 'react'
import {
  clearSlot,
  commitSlot,
  getRejectionReasons,
  loadSession,
  recordRejectReason,
  removeCommonReason,
  reorderItems as reorderItemsCall,
  saveSession,
  savePlanNotes,
  savePlanTheme,
  searchSongs,
  suggestSongs,
  type AiAction,
  type AiCandidate,
  type AiDebug,
  type CommonReason,
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
import { ArrangementKeyEditor } from './ArrangementKeyEditor'
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
  /** Title the slot had right before this candidate was committed. Used
   *  by clearPickedSlot to restore that title in PCO instead of leaving
   *  the song name behind. */
  priorSlotTitle: string | null
  /** Free-text reason for rejecting. Drives the AI's "use the reject
   *  reasons to understand direction" behavior. Null on unrejected
   *  candidates, or rejected ones the user didn't bother annotating. */
  rejectReason: string | null
  /** True once the user has clicked Skip on the rationale picker for
   *  this rejected candidate. SPA-only state, used to decide whether
   *  the card lives in the "needs reason" stack or the collapsed
   *  done pool. Resets on un-reject. */
  rejectPickerDismissed: boolean
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
    priorSlotTitle: c.priorSlotTitle,
    rejectReason: c.rejectReason,
    rejectPickerDismissed: c.rejectPickerDismissed,
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
    priorSlotTitle: p.priorSlotTitle ?? null,
    rejectReason: p.rejectReason ?? null,
    rejectPickerDismissed: p.rejectPickerDismissed ?? false,
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
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<CandidateMatch[]>([])
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [debug, setDebug] = useState<AiDebug | null>(null)
  // Global one-tap reason chips for the reject-rationale UI. Loaded
  // once per plan view and refreshed after every chip-list mutation
  // (record/remove). Empty until the callable returns.
  const [reasonChips, setReasonChips] = useState<CommonReason[]>([])
  // When set, the rationale picker panel renders at the top of the
  // rejected pool, scoped to this candidate. Cleared on submit or
  // when the candidate is no longer in the reject state.
  const [rationaleFocusId, setRationaleFocusId] = useState<string | null>(null)
  // Per-candidate draft text for the freeform textarea. Keyed by
  // candidate id so multiple drafts coexist across re-focusing.
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({})
  // Whether the rejected-pool <details> is open. Defaults closed; we
  // flip to true the first time anything gets rejected so the user
  // sees the rationale UI without an extra click.
  const [rejectedPoolOpen, setRejectedPoolOpen] = useState(false)

  const themeInitialized = useRef(false)
  const notesInitialized = useRef(false)

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
  // Auto-scroll target: as text streams into the in-flight assistant
  // message (or any new message lands), keep the log pinned to the
  // bottom so new content stays visible without manual scrolling.
  const chatLogRef = useRef<HTMLDivElement | null>(null)
  // Debounced auto-AI-turn after the user adjusts state without
  // typing. Gated by a pair of unserved-signal counters so a single
  // click-and-move-on reject doesn't trigger a heavyweight chat
  // turn — fires only when the cumulative changes since the last AI
  // turn cross a threshold worth the model's attention. Routes
  // through the normal streaming pipeline with autoRefresh: true so
  // the model's reply stays terse.
  const autoRefineTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tally of fresh rejects since the last AI turn fired. Cluster
  // threshold is 2 — a single reject alone does nothing.
  const unservedRejectsRef = useRef(0)
  // Tally of reject-reason saves (chip click OR freeform text)
  // since the last AI turn. ANY reason save fires the refresh,
  // because reasons are higher-signal context the model can act on.
  const unservedReasonSavesRef = useRef(0)
  // generating mirrored as a ref so the debounced timer reads the
  // current value when it fires, not the value captured at schedule
  // time (which would skip the firing once a slow manual Send is
  // still in flight, etc.).
  const generatingRef = useRef(false)

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
    userTouchedTheme.current = false
    userTouchedNotes.current = false

    setCandidates([])
    setMessages([])
    setSessionLoaded(false)
    setDebug(null)

    // Reset rationale UI state when switching plans so stale draft text
    // or focus from a different plan doesn't leak over.
    setRationaleFocusId(null)
    setReasonDrafts({})
    setRejectedPoolOpen(false)
    // Cancel any pending auto-refine carried over from a prior plan.
    if (autoRefineTimer.current) {
      clearTimeout(autoRefineTimer.current)
      autoRefineTimer.current = null
    }
    unservedRejectsRef.current = 0
    unservedReasonSavesRef.current = 0

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
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))

    return () => {
      cancelled = true
    }
  }, [serviceTypeId, planId])

  // Load the global reject-reason chip pool. App-wide list, so we fetch
  // once on mount and refresh in place after any add/remove call.
  useEffect(() => {
    let cancelled = false
    getRejectionReasons()
      .then((res) => {
        if (cancelled) return
        setReasonChips(res.data.common)
      })
      .catch(() => {
        // Non-fatal: chip row is empty until the user wires a successful
        // call. The freeform textarea still works.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Pin the chat log to the bottom whenever messages change so
  // streaming text + new turns stay in view. Cheap — only fires on
  // messages array updates, which is the same trigger as new content.
  useEffect(() => {
    const el = chatLogRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  // Keep the generating mirror in sync.
  useEffect(() => {
    generatingRef.current = generating
  }, [generating])

  // If the focused candidate is no longer rejected (un-rejected, cleared,
  // etc.), drop the focus so the rationale picker doesn't dangle on a
  // candidate that's no longer in the reject state.
  useEffect(() => {
    if (!rationaleFocusId) return
    const c = candidates.find((x) => x.id === rationaleFocusId)
    if (!c || c.decision !== 'reject') {
      setRationaleFocusId(null)
    }
  }, [candidates, rationaleFocusId])

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

  // Reconcile committed candidates with the current PCO service order.
  // If a slot was cleared (or had a different song committed to it) via
  // PCO directly, any candidate that still believes it owns that slot
  // gets reset to uncommitted/pending so the SPA's UI matches PCO state
  // and the AI no longer sees that song occupying the slot.
  useEffect(() => {
    if (!items || !sessionLoaded) return
    const staleIds: string[] = []
    for (const c of candidates) {
      if (c.committedAt == null) continue
      const slot = items.find((it) => it.id === c.assignedSlotItemId)
      const stillCommitted =
        !!slot && !!slot.songId && c.song?.id === slot.songId
      if (!stillCommitted) staleIds.push(c.id)
    }
    if (staleIds.length === 0) return
    const staleSet = new Set(staleIds)
    setCandidates((prev) =>
      prev.map((c) =>
        staleSet.has(c.id)
          ? { ...c, committedAt: null, priorSlotTitle: null }
          : c,
      ),
    )
    appendSystemMessage(
      `↺ ${staleIds.length} slot${staleIds.length === 1 ? '' : 's'} cleared in Planning Center — matching candidate${staleIds.length === 1 ? '' : 's'} marked uncommitted`,
    )
  }, [items, candidates, sessionLoaded])

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

  // Library-match lookup for a freshly-proposed candidate. Same pattern
  // we used inline before, hoisted now that propose-songs can fire from
  // multiple call sites (a single AI turn can emit multiple proposals).
  function searchAndAttachSong(c: CandidateMatch) {
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
            cur.id === c.id ? { ...cur, matchStatus: 'error', error: e.message } : cur,
          ),
        )
      })
  }

  // Send the user's turn to the AI and apply whatever actions it
  // chose. Streams: text deltas append to the assistant chat message
  // as the model types; each tool_use becomes an applied action plus
  // a 🤖 system message the moment its JSON arrives. The final
  // SuggestResponse still lands on `data` so we get debug payloads
  // and the model's full prose reply (used as a fallback if the
  // stream produced no text).
  //
  // `autoRefresh` distinguishes two call paths:
  //   - manual Send (default): user typed something, criteria becomes
  //     the user turn in the chat log, then clears.
  //   - auto-refresh (debounced after rejects): no user typed input,
  //     a system marker takes the place of the user turn so the chat
  //     log shows the AI is reacting on its own, and criteria stays
  //     intact so the user's next manual draft isn't clobbered.
  async function handleSuggest(opts?: { autoRefresh?: boolean }) {
    const autoRefresh = opts?.autoRefresh === true
    if (!theme.trim() || generating) return
    // Cancel any pending auto-refine — this turn covers it.
    if (autoRefineTimer.current) {
      clearTimeout(autoRefineTimer.current)
      autoRefineTimer.current = null
    }
    setGenerating(true)
    setGenerateError(null)
    patchCachedTheme(serviceTypeId, planId, theme)
    void savePlanTheme({ planId, theme }).catch(() => {})
    patchCachedNotes(serviceTypeId, planId, notesText)
    void savePlanNotes({ planId, notes: notesText }).catch(() => {})

    // Snapshot the typed input. Manual sends clear it (so the user can
    // start composing the next turn while the model streams);
    // auto-refresh leaves it alone (the user didn't initiate, don't
    // wipe their in-progress draft).
    const turnUserMessage = autoRefresh ? '' : criteria
    if (!autoRefresh) setCriteria('')

    try {
      const songSlotItems = (items ?? []).filter(isSongSlot)
      const totalSongSlots = songSlotItems.length
      // Map PCO item id ↔ 1-based position among song slots. Both
      // directions: we send positions to the AI and translate
      // reassign actions back to item ids.
      const slotIndexByItemId = new Map<string, number>()
      const itemIdBySlotIndex = new Map<number, string>()
      songSlotItems.forEach((it, idx) => {
        slotIndexByItemId.set(it.id, idx + 1)
        itemIdBySlotIndex.set(idx + 1, it.id)
      })

      const aiCandidates: AiCandidate[] = candidates.map((c) => {
        const slotIndex = c.assignedSlotItemId
          ? slotIndexByItemId.get(c.assignedSlotItemId)
          : undefined
        return {
          id: c.id,
          title: c.suggestion.title,
          author: c.suggestion.author,
          chorusSnippet: c.suggestion.chorusSnippet,
          slots:
            c.suggestion.slots && c.suggestion.slots.length > 0
              ? c.suggestion.slots
              : undefined,
          decision: c.decision,
          rejectReason: c.rejectReason ?? undefined,
          assignedSlot:
            slotIndex !== undefined && totalSongSlots > 0
              ? { index: slotIndex, total: totalSongSlots }
              : undefined,
          committed: c.committedAt != null,
        }
      })

      const committedSongIds = new Set(
        candidates
          .filter((c) => c.committedAt != null && c.song?.id)
          .map((c) => c.song!.id),
      )
      const alreadyInPlan = (items ?? [])
        .filter(
          (it) => it.songId && it.songTitle && !committedSongIds.has(it.songId),
        )
        .map((it) => it.songTitle!)

      const serviceOrder = buildServiceOrderText(items)
      const history: ConversationTurn[] = messages.map((m) =>
        m.role === 'system'
          ? { role: 'user' as const, content: `[event] ${m.content}` }
          : { role: m.role, content: m.content },
      )

      // Pre-allocate an id for the placeholder assistant message so
      // stream chunks can find it to append into. Manual sends also
      // prepend a user message; auto-refresh prepends a system
      // marker instead so the chat log shows the AI is reacting on
      // its own rather than to a (nonexistent) typed turn.
      const assistantMsgId = newCandidateId()
      const turnTs = Date.now()
      const turnPrefix: SessionMessage = autoRefresh
        ? {
            id: newCandidateId(),
            role: 'system',
            content: '↻ Auto-refining after recent activity',
            timestamp: turnTs,
          }
        : {
            id: newCandidateId(),
            role: 'user',
            content: turnUserMessage.trim() || '(initial request)',
            timestamp: turnTs,
          }
      setMessages((prev) => [
        ...prev,
        turnPrefix,
        {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          timestamp: turnTs + 1,
        },
      ])

      // Per-turn dedupe set used while applying propose actions —
      // case-insensitive against existing candidates + alreadyInPlan,
      // also dedupes within the same turn.
      const existingTitlesLower = new Set<string>([
        ...candidates.map((c) => c.suggestion.title.toLowerCase()),
        ...alreadyInPlan.map((t) => t.toLowerCase()),
      ])
      // Title lookup for system messages on remove/reassign actions.
      // Built once from the pre-turn candidate list; new candidates
      // proposed in this same turn get folded in as they arrive.
      const titleById = new Map(
        candidates.map((c): [string, string] => [c.id, c.suggestion.title]),
      )
      // Pre-turn candidate lookup by id (for AI write actions that
      // need full candidate data: matched PCO song id, etc).
      const preTurnCandidatesById = new Map(
        candidates.map((c): [string, CandidateMatch] => [c.id, c]),
      )

      let streamedText = ''
      // PCO writes (commit/clear) fire fire-and-forget against the
      // optimistic SPA state. We collect their promises so the
      // post-stream cleanup can await them and trigger a single
      // items refresh once everything has landed.
      const pendingPcoWrites: Promise<void>[] = []
      let pcoWritesFired = false

      const applyAction = (action: AiAction) => {
        const now = Date.now()
        if (action.kind === 'propose') {
          const minted: CandidateMatch[] = []
          for (const s of action.suggestions) {
            const key = s.title.toLowerCase()
            if (existingTitlesLower.has(key)) continue
            existingTitlesLower.add(key)
            const c: CandidateMatch = {
              id: newCandidateId(),
              suggestion: s,
              matchStatus: 'checking',
              decision: 'pending',
              addedAt: now,
              assignedSlotItemId: null,
              committedAt: null,
              priorSlotTitle: null,
              rejectReason: null,
              rejectPickerDismissed: false,
            }
            minted.push(c)
            titleById.set(c.id, c.suggestion.title)
          }
          if (minted.length > 0) {
            setCandidates((prev) => [...prev, ...minted])
            minted.forEach(searchAndAttachSong)
            appendSystemMessage(
              `🤖 AI proposed ${minted.length} new song${minted.length === 1 ? '' : 's'}`,
            )
          }
        } else if (action.kind === 'remove') {
          setCandidates((prev) =>
            prev.map((c) =>
              action.ids.includes(c.id) && !c.committedAt
                ? { ...c, decision: 'reject', rejectReason: action.reason }
                : c,
            ),
          )
          const titles = action.ids
            .map((id) => titleById.get(id) ?? `(unknown ${id})`)
            .join(', ')
          appendSystemMessage(
            `🤖 AI rejected ${titles} — reason: "${action.reason}"`,
          )
          setRejectedPoolOpen(true)
        } else if (action.kind === 'reassign') {
          const targetItemId = itemIdBySlotIndex.get(action.slotIndex) ?? null
          if (targetItemId == null) return
          setCandidates((prev) =>
            prev.map((c) =>
              c.id === action.candidateId && !c.committedAt
                ? { ...c, assignedSlotItemId: targetItemId }
                : c,
            ),
          )
          const title = titleById.get(action.candidateId) ?? '(candidate)'
          appendSystemMessage(
            `🤖 AI moved "${title}" to song slot ${action.slotIndex}`,
          )
        } else if (action.kind === 'commit') {
          // Defensive: the system prompt tells the AI not to commit
          // during auto-refresh, but a guard here prevents a
          // misbehaving turn from silently writing to PCO anyway.
          if (autoRefresh) {
            appendSystemMessage(
              `⚠ AI tried to commit a song during auto-refresh — skipped (commits require explicit direction)`,
            )
            return
          }
          const candidate = preTurnCandidatesById.get(action.candidateId)
          if (!candidate) {
            appendSystemMessage(
              `⚠ AI tried to commit an unknown candidate (${action.candidateId}) — skipped`,
            )
            return
          }
          if (!candidate.song?.id) {
            appendSystemMessage(
              `⚠ AI tried to commit "${candidate.suggestion.title}" but it isn't matched to a song in your Planning Center library — skipped`,
            )
            return
          }
          const targetItemId = itemIdBySlotIndex.get(action.slotIndex)
          if (!targetItemId) {
            appendSystemMessage(
              `⚠ AI tried to commit "${candidate.suggestion.title}" to song slot ${action.slotIndex}, but no such slot exists — skipped`,
            )
            return
          }
          const songId = candidate.song.id
          const songTitle = candidate.suggestion.title
          const slotItem = (items ?? []).find((it) => it.id === targetItemId)
          const priorSlotTitle = slotItem?.title ?? null
          // Optimistic flip — UI shows the candidate as committed
          // immediately; rolls back if the PCO call rejects.
          setCandidates((prev) =>
            prev.map((c) =>
              c.id === action.candidateId
                ? {
                    ...c,
                    committedAt: now,
                    assignedSlotItemId: targetItemId,
                    priorSlotTitle,
                  }
                : c,
            ),
          )
          appendSystemMessage(
            `🤖 AI committed "${songTitle}" to song slot ${action.slotIndex}`,
          )
          pcoWritesFired = true
          pendingPcoWrites.push(
            commitSlot({
              serviceTypeId,
              planId,
              itemId: targetItemId,
              songId,
              songTitle,
            })
              .then(() => undefined)
              .catch((e: Error) => {
                setCandidates((prev) =>
                  prev.map((c) =>
                    c.id === action.candidateId
                      ? {
                          ...c,
                          committedAt: null,
                          assignedSlotItemId: null,
                          priorSlotTitle: null,
                        }
                      : c,
                  ),
                )
                appendSystemMessage(
                  `⚠ AI commit failed for "${songTitle}" — ${e.message}`,
                )
              }),
          )
        } else if (action.kind === 'clear_slot') {
          if (autoRefresh) {
            appendSystemMessage(
              `⚠ AI tried to clear a slot during auto-refresh — skipped`,
            )
            return
          }
          const targetItemId = itemIdBySlotIndex.get(action.slotIndex)
          if (!targetItemId) {
            appendSystemMessage(
              `⚠ AI tried to clear song slot ${action.slotIndex}, but no such slot exists — skipped`,
            )
            return
          }
          // Find the candidate currently committed to this slot (if
          // any) so we can restore its prior slot title and capture
          // a snapshot for rollback.
          const committedCandidate = candidates.find(
            (c) => c.assignedSlotItemId === targetItemId && c.committedAt != null,
          )
          const restoreTitle =
            committedCandidate?.priorSlotTitle?.trim() ||
            fallbackSlotTitle(targetItemId)
          const songTitle = committedCandidate?.suggestion.title ?? 'song'
          const rollbackSnapshot = committedCandidate
            ? {
                id: committedCandidate.id,
                committedAt: committedCandidate.committedAt,
                assignedSlotItemId: committedCandidate.assignedSlotItemId,
                priorSlotTitle: committedCandidate.priorSlotTitle,
              }
            : null
          setCandidates((prev) =>
            prev.map((c) =>
              c.assignedSlotItemId === targetItemId
                ? {
                    ...c,
                    committedAt: null,
                    assignedSlotItemId: null,
                    priorSlotTitle: null,
                  }
                : c,
            ),
          )
          appendSystemMessage(
            `🤖 AI cleared "${songTitle}" from song slot ${action.slotIndex}`,
          )
          pcoWritesFired = true
          pendingPcoWrites.push(
            clearSlot({
              serviceTypeId,
              planId,
              itemId: targetItemId,
              title: restoreTitle,
            })
              .then(() => undefined)
              .catch((e: Error) => {
                if (rollbackSnapshot) {
                  setCandidates((prev) =>
                    prev.map((c) =>
                      c.id === rollbackSnapshot.id
                        ? {
                            ...c,
                            committedAt: rollbackSnapshot.committedAt,
                            assignedSlotItemId:
                              rollbackSnapshot.assignedSlotItemId,
                            priorSlotTitle: rollbackSnapshot.priorSlotTitle,
                          }
                        : c,
                    ),
                  )
                }
                appendSystemMessage(
                  `⚠ AI clear failed for song slot ${action.slotIndex} — ${e.message}`,
                )
              }),
          )
        } else if (action.kind === 'unreject') {
          setCandidates((prev) =>
            prev.map((c) =>
              action.ids.includes(c.id) && c.decision === 'reject'
                ? {
                    ...c,
                    decision: 'pending',
                    rejectReason: null,
                    rejectPickerDismissed: false,
                  }
                : c,
            ),
          )
          const titles = action.ids
            .map((id) => titleById.get(id) ?? `(unknown ${id})`)
            .join(', ')
          appendSystemMessage(
            `🤖 AI restored ${titles} to the candidate pool`,
          )
        }
      }

      const { stream, data } = await suggestSongs.stream({
        theme,
        userMessage: turnUserMessage,
        planId,
        serviceOrder,
        planNotes: notesText,
        history,
        candidates: aiCandidates,
        alreadyInPlan,
        autoRefresh,
      })

      for await (const chunk of stream) {
        if (chunk.kind === 'text') {
          streamedText += chunk.delta
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: m.content + chunk.delta }
                : m,
            ),
          )
        } else if (chunk.kind === 'action') {
          applyAction(chunk.action)
        }
      }

      const final = await data
      setDebug(final.debug ?? null)
      // If streaming produced no text but the callable's fallback
      // synthesized a status line, drop it into the placeholder so the
      // chat log isn't blank. Also handles the unlikely case where the
      // client used the stream but never got any text deltas.
      if (!streamedText.trim() && final.message) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, content: final.message } : m,
          ),
        )
      }
      // Await any AI-driven PCO writes before unfreezing the UI so the
      // post-turn items refresh sees their effects. Catches inside the
      // promise itself handle rollback; the await here just sequences.
      if (pendingPcoWrites.length > 0) {
        await Promise.all(pendingPcoWrites)
      }
      // Single items refresh after the turn — picks up commits, clears,
      // title restorations all in one PCO read.
      if (pcoWritesFired) {
        invalidatePlanContext(serviceTypeId, planId)
        try {
          const fresh = await loadPlanContext(serviceTypeId, planId)
          setItems(fresh.items)
        } catch {
          // Items refresh is best-effort. The optimistic state still
          // reflects what we intended; user can hard-refresh to pick
          // up any drift.
        }
      }
    } catch (e) {
      setGenerateError((e as Error).message)
    } finally {
      setGenerating(false)
      // This turn served whatever signals had accumulated — reset
      // the unserved-counters so the next auto-refresh threshold
      // starts counting from zero again.
      unservedRejectsRef.current = 0
      unservedReasonSavesRef.current = 0
    }
  }

  function clearCandidates() {
    setCandidates([])
    setMessages([])
    setDebug(null)
    if (autoRefineTimer.current) {
      clearTimeout(autoRefineTimer.current)
      autoRefineTimer.current = null
    }
    unservedRejectsRef.current = 0
    unservedReasonSavesRef.current = 0
  }

  // 5-second debounce. Each new signal resets the timer so rapid
  // rejections coalesce into a single auto-fire rather than each
  // resetting a tight window. At fire time the timer re-checks the
  // gating thresholds (counters are captured by ref so the check
  // sees latest values, not the values at schedule time).
  //
  // Gating:
  //   - 2+ fresh rejects since the last AI turn (a cluster), OR
  //   - 1+ reject-reason saves since the last AI turn (high signal —
  //     the user gave the AI new information about what to avoid)
  //
  // A single click-only reject doesn't fire anything. The user can
  // always click Send manually if they want the AI to engage.
  function scheduleAutoRefine() {
    if (autoRefineTimer.current) clearTimeout(autoRefineTimer.current)
    autoRefineTimer.current = setTimeout(() => {
      autoRefineTimer.current = null
      if (generatingRef.current) return
      const enoughRejects = unservedRejectsRef.current >= 2
      const anyReasonSaves = unservedReasonSavesRef.current >= 1
      if (!enoughRejects && !anyReasonSaves) return
      void handleSuggest({ autoRefresh: true })
    }, 5000)
  }

  function bumpRejectSignal() {
    unservedRejectsRef.current += 1
    scheduleAutoRefine()
  }

  function bumpReasonSignal() {
    unservedReasonSavesRef.current += 1
    scheduleAutoRefine()
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
        // Un-rejection wipes any stored reason AND any "Skip dismissed"
        // flag — the candidate is back in play, both bits of reject
        // state no longer apply.
        const clearReject = newDecision !== 'reject'
        return {
          ...c,
          decision: newDecision,
          assignedSlotItemId: clearAssignment ? null : c.assignedSlotItemId,
          rejectReason: clearReject ? null : c.rejectReason,
          rejectPickerDismissed: clearReject ? false : c.rejectPickerDismissed,
        }
      }),
    )

    // Surface decision changes in the chat log so the conversation
    // captures everything that shapes future suggestions, not just
    // typed refinements.
    if (newDecision === 'reject' && oldDecision !== 'reject') {
      appendSystemMessage(`✗ Rejected: ${target.suggestion.title}`)
      // Newly-rejected cards land in the needs-attention stack
      // (always visible) with the picker pre-rendered — no focus
      // state needed. The done pool stays however the user left it.
      // Count this toward the reject-cluster threshold. A single
      // click-only reject doesn't auto-fire the AI on its own; we
      // only trigger once the user's adjustments cross a threshold
      // (see scheduleAutoRefine).
      bumpRejectSignal()
    } else if (oldDecision === 'reject' && newDecision !== 'reject') {
      appendSystemMessage(`↩ Unrejected: ${target.suggestion.title}`)
    }
  }

  // Set a candidate's reject reason locally (no server call). Used by
  // chip clicks where the global list already knows about the reason.
  function setCandidateReason(candidateId: string, reason: string | null) {
    const trimmed = reason ? reason.trim() : null
    setCandidates((prev) =>
      prev.map((c) =>
        c.id === candidateId && c.decision === 'reject'
          ? { ...c, rejectReason: trimmed && trimmed.length > 0 ? trimmed : null }
          : c,
      ),
    )
    // Clear any draft text now that we've committed a reason.
    setReasonDrafts((prev) => {
      if (!(candidateId in prev)) return prev
      const next = { ...prev }
      delete next[candidateId]
      return next
    })
    setRationaleFocusId(null)
  }

  // Save a freeform-typed reason. Same as setCandidateReason plus a
  // server-side call so the global log + distillation trigger see the
  // new text. Refreshes chips from the response.
  async function saveFreeformReason(candidateId: string, reason: string) {
    const trimmed = reason.trim()
    if (!trimmed) {
      setCandidateReason(candidateId, null)
      return
    }
    setCandidateReason(candidateId, trimmed)
    // High-signal context the AI hasn't seen yet. Counts as a
    // reason-save in the auto-refine gating.
    bumpReasonSignal()
    try {
      const res = await recordRejectReason({ reason: trimmed })
      setReasonChips(res.data.common)
    } catch {
      // Recording is best-effort — local reason is already saved. The
      // global chip pool just won't grow this time.
    }
  }

  // Skip the rationale picker for a needs-attention card — moves it
  // to the collapsed done pool without saving a reason. If a focused
  // edit was in progress on this card, exit that too.
  function dismissRejectPicker(id: string) {
    setCandidates((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, rejectPickerDismissed: true } : c,
      ),
    )
    if (rationaleFocusId === id) setRationaleFocusId(null)
    setReasonDrafts((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  // Click "+ add reason" on a dismissed card in the done pool: clears
  // the dismissed flag so the card reappears in the needs-attention
  // stack with its picker open.
  function undismissRejectPicker(id: string) {
    setCandidates((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, rejectPickerDismissed: false } : c,
      ),
    )
  }

  // Click "edit" on a with-reason card in the done pool: enters edit
  // mode for that specific card (the picker renders inline within
  // the done card via rationaleFocusId), with the existing reason
  // pre-filled as the textarea draft so the user can tweak rather
  // than retype.
  function startEditingReason(id: string) {
    const candidate = candidates.find((c) => c.id === id)
    if (!candidate || candidate.decision !== 'reject') return
    setReasonDrafts((prev) => ({
      ...prev,
      [id]: candidate.rejectReason ?? '',
    }))
    setRationaleFocusId(id)
  }

  // Skip during edit-of-existing-reason: exit edit mode without
  // changing anything. Done from a focused done card.
  function cancelEditingReason(id: string) {
    if (rationaleFocusId === id) setRationaleFocusId(null)
    setReasonDrafts((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  async function removeReasonChip(text: string) {
    // Optimistic local update so the chip disappears immediately.
    setReasonChips((prev) => prev.filter((c) => c.text !== text))
    try {
      const res = await removeCommonReason({ text })
      setReasonChips(res.data.common)
    } catch {
      // Restore by refetching if the call failed.
      try {
        const res = await getRejectionReasons()
        setReasonChips(res.data.common)
      } catch {
        // Give up; user can refresh.
      }
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

  // Generate the SPA's fallback slot title for a given song-slot item —
  // "Song N" where N is its 1-based position among song slots in the
  // current service order. Used when clearing a committed slot for which
  // we have no stored prior title (e.g. session candidates were cleared,
  // or the candidate predates the priorSlotTitle field).
  function fallbackSlotTitle(itemId: string): string {
    const songSlotItems = (items ?? []).filter(isSongSlot)
    const idx = songSlotItems.findIndex((s) => s.id === itemId)
    return idx >= 0 ? `Song ${idx + 1}` : 'Song'
  }

  async function clearPickedSlot(itemId: string) {
    const slot = (items ?? []).find((it) => it.id === itemId)
    if (!slot || !slot.songId) return
    const clearedSongTitle = slot.songTitle ?? '(song)'
    // Prefer the title we captured when we committed to this slot;
    // otherwise fall back to the "Song N" convention so the slot
    // doesn't keep the song name as its label.
    const committedCandidate = candidates.find(
      (c) =>
        c.assignedSlotItemId === itemId &&
        c.committedAt != null &&
        c.priorSlotTitle &&
        c.priorSlotTitle.trim() !== '',
    )
    const restoreTitle =
      committedCandidate?.priorSlotTitle?.trim() || fallbackSlotTitle(itemId)
    try {
      await clearSlot({ serviceTypeId, planId, itemId, title: restoreTitle })
      // Any candidate that was committed (or just assigned) to this slot
      // should drop back to an uncommitted/unassigned state — the slot
      // it pointed at no longer holds anything. Also clear the captured
      // priorSlotTitle since the slot's title has now been restored.
      setCandidates((prev) =>
        prev.map((c) =>
          c.assignedSlotItemId === itemId
            ? {
                ...c,
                assignedSlotItemId: null,
                committedAt: null,
                priorSlotTitle: null,
              }
            : c,
        ),
      )
      appendSystemMessage(
        `↶ Cleared "${clearedSongTitle}" from ${restoreTitle} — the AI will treat this slot as open again`,
      )
      // Refresh the service order so the slot flips back to empty in
      // the SPA (and in the AI's next service-order context).
      invalidatePlanContext(serviceTypeId, planId)
      const fresh = await loadPlanContext(serviceTypeId, planId)
      setItems(fresh.items)
    } catch (e) {
      setGenerateError((e as Error).message)
    }
  }

  // Drag-and-drop state. Two distinct drag modes:
  //   - 'candidate': dragging an AI suggestion onto an empty service-
  //     order slot. Drop assigns + commits in one step.
  //   - 'slot':      dragging a filled song slot onto the trash zone
  //     that appears at the top of the page mid-drag. Drop clears.
  // The drop-target highlights and the floating trash zone are gated on
  // this state.
  const [dragKind, setDragKind] = useState<'candidate' | 'slot' | null>(null)
  // Source identifier — candidate.id for 'candidate' drags, item.id for
  // 'slot' drags. We thread the source through React state rather than
  // dataTransfer.getData because some browsers (notably Firefox)
  // restrict reading custom mime types from dataTransfer in the drop
  // event, which would silently break the handler.
  const [dragSourceId, setDragSourceId] = useState<string | null>(null)
  // Hovered drop-target ids so we can highlight the specific slot or the
  // trash zone the user is over, instead of every valid target at once.
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null)
  const [dragOverTrash, setDragOverTrash] = useState(false)

  // Floating-ghost we render ourselves at the cursor position during a
  // drag. The browser-default drag image was rendering blank, and
  // setDragImage on a styled clone also failed for this user — likely
  // a Chromium quirk on Retina-class displays. So we suppress the
  // browser's ghost entirely and paint our own labeled chip via a
  // dragover listener on the document.
  const [dragGhost, setDragGhost] = useState<{
    label: string
    sub: string | null
    x: number
    y: number
  } | null>(null)

  function endDrag() {
    setDragKind(null)
    setDragSourceId(null)
    setDragOverItemId(null)
    setDragOverTrash(false)
    setDragGhost(null)
  }

  // While any drag is active, follow the cursor with our floating
  // ghost via the document-level dragover event (dragover fires
  // continuously and reports clientX/clientY).
  useEffect(() => {
    if (!dragGhost) return
    function onMove(e: DragEvent) {
      // clientX/Y can briefly hit 0,0 right before drop on some
      // browsers; ignore those to avoid the ghost teleporting to the
      // corner.
      if (e.clientX === 0 && e.clientY === 0) return
      setDragGhost((prev) =>
        prev ? { ...prev, x: e.clientX, y: e.clientY } : null,
      )
    }
    document.addEventListener('dragover', onMove)
    return () => document.removeEventListener('dragover', onMove)
  }, [dragGhost !== null])

  // Suppress the browser's default drag image so it doesn't compete
  // with our floating ghost (and so users on Chromium/Retina don't see
  // it render as a blank rectangle either). A 1×1 transparent canvas
  // is the standard "invisible drag image" trick.
  function suppressNativeDragImage(e: React.DragEvent): void {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    try {
      e.dataTransfer.setDragImage(canvas, 0, 0)
    } catch {
      // Ignored — falls back to the browser default. We have the
      // floating ghost too, so the user still sees something.
    }
  }


  // Drop handler for a filled song slot dragged onto another song slot.
  // Branches on the target's state per the user's mental model — slots
  // are fixed positions, songs move between them:
  //
  //   - target empty  → MOVE the song. Source vacates (title reverts
  //     to its stored priorSlotTitle, song relationship cleared),
  //     destination receives the song with full commit semantics.
  //   - target filled → SWAP positions via item_reorder. Both slots
  //     move positions; their attached songs follow. priorSlotTitle is
  //     wiped on both candidates so a future Clear falls back to
  //     "Song N" at the slot's new position.
  async function reorderSlotItem(draggedId: string, targetId: string) {
    if (draggedId === targetId) return
    const draggedSlot = (items ?? []).find((it) => it.id === draggedId)
    const targetSlot = (items ?? []).find((it) => it.id === targetId)
    if (!draggedSlot || !targetSlot) return

    if (!targetSlot.songId) {
      await moveSongToEmptySlot(draggedSlot, targetSlot)
    } else {
      await swapTwoFilledSlots(draggedSlot, targetSlot)
    }
  }

  // Vacate the source slot (restoring its prior title) and commit the
  // source's song to the empty destination. Candidate that owned the
  // source's commitment migrates to the destination with its
  // priorSlotTitle replaced by the destination slot's pre-move title,
  // so a future Clear on the destination restores its identity (e.g.
  // "Song 2") rather than the source's identity.
  async function moveSongToEmptySlot(source: PlanItem, target: PlanItem) {
    const committedCand = candidates.find(
      (c) =>
        c.assignedSlotItemId === source.id &&
        c.committedAt != null &&
        c.song,
    )
    const songId = committedCand?.song?.id ?? source.songId
    const songTitle = committedCand?.song?.title ?? source.songTitle
    if (!songId || !songTitle) {
      setGenerateError(
        `Can't move "${source.songTitle ?? source.title}" — missing song info on the source slot.`,
      )
      return
    }
    const sourceRestoreTitle =
      committedCand?.priorSlotTitle?.trim() || fallbackSlotTitle(source.id)
    const destPriorTitle = target.title?.trim() || fallbackSlotTitle(target.id)
    try {
      await clearSlot({
        serviceTypeId,
        planId,
        itemId: source.id,
        title: sourceRestoreTitle,
      })
      await commitSlot({
        serviceTypeId,
        planId,
        itemId: target.id,
        songId,
        songTitle,
      })
      // Refresh items FIRST so the reconciliation effect sees the
      // target slot already holding the song before the candidate
      // points at it — otherwise the effect runs once on
      // new-candidate-vs-old-items and resets committedAt because the
      // stale target still shows songId: null.
      invalidatePlanContext(serviceTypeId, planId)
      const fresh = await loadPlanContext(serviceTypeId, planId)
      setItems(fresh.items)
      // Migrate the committed candidate to the destination, refreshing
      // its priorSlotTitle so a future Clear restores the destination
      // slot's identity rather than the source's.
      if (committedCand) {
        setCandidates((prev) =>
          prev.map((c) =>
            c.id === committedCand.id
              ? {
                  ...c,
                  assignedSlotItemId: target.id,
                  priorSlotTitle: destPriorTitle,
                }
              : c,
          ),
        )
      }
      appendSystemMessage(
        `↕ Moved "${songTitle}" into the ${destPriorTitle} slot`,
      )
    } catch (e) {
      setGenerateError((e as Error).message)
    }
  }

  // Both slots are filled — swap their service-order positions via the
  // PCO item_reorder action. Slots and songs travel together (the song
  // stays with its slot). Both candidates' priorSlotTitle is wiped
  // since each affected slot now sits at a different position.
  async function swapTwoFilledSlots(a: PlanItem, b: PlanItem) {
    const order = (items ?? []).map((it) => it.id)
    const aIdx = order.indexOf(a.id)
    const bIdx = order.indexOf(b.id)
    if (aIdx === -1 || bIdx === -1) return
    const newOrder = [...order]
    newOrder[aIdx] = b.id
    newOrder[bIdx] = a.id
    try {
      await reorderItemsCall({
        serviceTypeId,
        planId,
        orderedItemIds: newOrder,
      })
      // Refresh items first (same race-avoidance pattern as
      // commitCandidate / moveSongToEmptySlot): the reconciliation
      // effect's stillCommitted check needs fresh items state when
      // candidates change.
      invalidatePlanContext(serviceTypeId, planId)
      const fresh = await loadPlanContext(serviceTypeId, planId)
      setItems(fresh.items)
      const affected = new Set([a.id, b.id])
      setCandidates((prev) =>
        prev.map((c) =>
          c.assignedSlotItemId && affected.has(c.assignedSlotItemId)
            ? { ...c, priorSlotTitle: null }
            : c,
        ),
      )
      const aLabel = a.songTitle ?? a.title ?? 'slot'
      const bLabel = b.songTitle ?? b.title ?? 'slot'
      appendSystemMessage(`↔ Swapped "${aLabel}" with "${bLabel}"`)
    } catch (e) {
      setGenerateError((e as Error).message)
    }
  }

  // Drop handler for "candidate dragged onto empty slot". Reuses the
  // commit path, but synthesises a candidate with the new
  // assignedSlotItemId so commitCandidate sees the slot assignment on
  // its first read (avoids a setState + read race). Also promotes the
  // candidate to 'shortlist' since the "Committed" badge UI gates on
  // decision === 'shortlist' — without this the badge silently never
  // renders for drag-committed candidates.
  async function dropCandidateOnSlot(candidateId: string, slotItemId: string) {
    const candidate = candidates.find((c) => c.id === candidateId)
    if (!candidate || !candidate.song) return
    const slot = (items ?? []).find((it) => it.id === slotItemId)
    if (!slot || slot.songId) return // only empty song slots accept a drop
    const withSlot: CandidateMatch = {
      ...candidate,
      decision: 'shortlist',
      assignedSlotItemId: slotItemId,
      committedAt: null,
    }
    setCandidates((prev) =>
      prev.map((c) => (c.id === candidateId ? withSlot : c)),
    )
    await commitCandidate(withSlot)
  }

  async function commitCandidate(c: CandidateMatch) {
    if (!c.assignedSlotItemId || !c.song || c.committedAt) return
    const slot = (items ?? []).find((it) => it.id === c.assignedSlotItemId)
    // Capture the slot's title BEFORE we overwrite it with the song
    // name, so a later clear can restore it.
    const priorSlotTitle = slot?.title ?? ''
    const slotTitle = slot?.title ?? 'slot'
    try {
      await commitSlot({
        serviceTypeId,
        planId,
        itemId: c.assignedSlotItemId,
        songId: c.song.id,
        // Rewrite the item title so PCO shows the song name (matches
        // what its web UI does on song-link).
        songTitle: c.song.title,
      })
      // Refresh the service order FIRST so items show the slot as
      // filled before we mark the candidate as committed. Doing the
      // setCandidates(committed) call before this refresh let the
      // reconciliation effect see new-candidates-against-old-items,
      // mistake the commit for stale, and immediately reset
      // committedAt back to null. Batching both setItems and
      // setCandidates after the refresh resolves keeps state in
      // sync within a single render.
      invalidatePlanContext(serviceTypeId, planId)
      const fresh = await loadPlanContext(serviceTypeId, planId)
      setItems(fresh.items)
      setCandidates((prev) =>
        prev.map((x) =>
          x.id === c.id
            ? { ...x, committedAt: Date.now(), priorSlotTitle }
            : x,
        ),
      )
      appendSystemMessage(`↗ Committed “${c.suggestion.title}” → ${slotTitle}`)
    } catch (e) {
      setGenerateError((e as Error).message)
    }
  }

  if (loadError) return <div className="error">Error loading plan: {loadError}</div>
  if (!plan || !notes || !items) return <div>Loading plan…</div>

  const subtitle = plan.title && plan.seriesTitle ? plan.seriesTitle : null

  return (
    <div className="plan-detail">
      {dragGhost && (
        <div
          className="drag-ghost"
          style={{
            left: dragGhost.x + 14,
            top: dragGhost.y + 14,
          }}
        >
          <div className="drag-ghost-title">{dragGhost.label}</div>
          {dragGhost.sub && (
            <div className="drag-ghost-sub">{dragGhost.sub}</div>
          )}
        </div>
      )}
      {dragKind === 'slot' && (
        <div
          className={`slot-trash${dragOverTrash ? ' drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (!dragOverTrash) setDragOverTrash(true)
          }}
          onDragLeave={() => setDragOverTrash(false)}
          onDrop={(e) => {
            e.preventDefault()
            // Source id lives in React state now — the dataTransfer
            // payload was deprecated when we moved off the
            // application/x-songpicker custom mime type. Reading the
            // old key here silently no-op'd the clear.
            if (dragKind === 'slot' && dragSourceId) {
              void clearPickedSlot(dragSourceId)
            }
            endDrag()
          }}
          aria-label="Drop to clear this slot"
        >
          <span className="slot-trash-icon" aria-hidden>
            🗑
          </span>
          <span className="slot-trash-label">Drop to clear this slot</span>
        </div>
      )}
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
          <h3>Service order</h3>
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
              const draggable = isSong && filled
              const isCommitTarget =
                dragKind === 'candidate' && isSong && !filled
              // Only song slots (filled OR empty) accept reorder drops —
              // dropping onto a Welcome / Announcements / Sermon item
              // would be confusing because those aren't the "spots"
              // worship leaders think of as positions to slot songs
              // into.
              const isReorderTarget =
                dragKind === 'slot' &&
                dragSourceId !== null &&
                dragSourceId !== it.id &&
                isSong
              const isDropTarget = isCommitTarget || isReorderTarget
              const isBeingDragged =
                dragKind === 'slot' && dragSourceId === it.id
              return (
                <li
                  key={it.id}
                  className={`${cls}${isDropTarget ? ' drag-target' : ''}${
                    isDropTarget && dragOverItemId === it.id ? ' drag-over' : ''
                  }${isReorderTarget ? ' drag-target-reorder' : ''}${
                    draggable ? ' is-draggable' : ''
                  }${isBeingDragged ? ' is-dragging' : ''}`}
                  draggable={draggable || undefined}
                  onDragStart={(e) => {
                    if (!draggable) return
                    e.dataTransfer.setData('text/plain', it.id)
                    e.dataTransfer.effectAllowed = 'move'
                    suppressNativeDragImage(e)
                    setDragKind('slot')
                    setDragSourceId(it.id)
                    setDragGhost({
                      label: it.songTitle ?? it.title ?? 'song',
                      sub: it.songAuthor ?? null,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }}
                  onDragEnd={() => {
                    if (draggable) endDrag()
                  }}
                  onDragOver={(e) => {
                    if (!isDropTarget) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragOverItemId !== it.id) setDragOverItemId(it.id)
                  }}
                  onDragLeave={() => {
                    if (isDropTarget && dragOverItemId === it.id) {
                      setDragOverItemId(null)
                    }
                  }}
                  onDrop={(e) => {
                    if (!isDropTarget) return
                    e.preventDefault()
                    if (dragKind === 'candidate' && dragSourceId) {
                      void dropCandidateOnSlot(dragSourceId, it.id)
                    } else if (dragKind === 'slot' && dragSourceId) {
                      void reorderSlotItem(dragSourceId, it.id)
                    }
                    endDrag()
                  }}
                >
                  <span className="seq">{it.sequence}</span>
                  <div className="ibody">
                    {filled ? (
                      <div className="ititle-row">
                        <a
                          className="ititle ititle-link"
                          href={`https://services.planningcenteronline.com/songs/${it.songId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open song in Planning Center"
                          // Anchors are natively draggable (for URL
                          // drops); turn that off so the parent <li>
                          // gets the dragstart instead.
                          draggable={false}
                        >
                          {displayTitle || '(song)'} ↗
                        </a>
                        {isSong && (
                          <button
                            type="button"
                            className="clear-slot-btn"
                            onClick={() => clearPickedSlot(it.id)}
                            title="Remove this song from the slot and reopen it for new suggestions"
                            aria-label="Remove song from slot"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="ititle">{it.title || '(no title)'}</div>
                    )}
                    {isSong && !filled && (
                      <span className="song-empty">Pick a song</span>
                    )}
                    {showMeta && (
                      <div className="item-meta">
                        {(it.leaders.length > 0 || (!filled && it.keyName)) && (
                        <div className="meta-chips">
                          {!filled && it.keyName && (
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
                        )}
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
                  {filled && (it.songId || displayTitle) && (
                    <div className="item-actions">
                      {it.songId && (
                        <ArrangementKeyEditor
                          serviceTypeId={serviceTypeId}
                          planId={planId}
                          item={it}
                          onSaved={async () => {
                            invalidatePlanContext(serviceTypeId, planId)
                            const fresh = await loadPlanContext(serviceTypeId, planId)
                            setItems(fresh.items)
                          }}
                        />
                      )}
                      {displayTitle && (
                        <a
                          className="spotify-link"
                          href={spotifySearchUrl(displayTitle)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Search Spotify"
                          draggable={false}
                        >
                          Spotify ↗
                        </a>
                      )}
                    </div>
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
          <div className="chat-log" ref={chatLogRef}>
            {messages.map((m, idx) => {
              if (m.role === 'system') {
                return (
                  <div key={m.id} className="chat-msg chat-msg-system">
                    {m.content}
                  </div>
                )
              }
              // The in-flight assistant message gets a typing cursor
              // so the user can see it's still being generated even
              // when the model pauses between tokens. We detect it as
              // the last message in the log while generating is true
              // and the role is assistant.
              const isStreaming =
                generating &&
                m.role === 'assistant' &&
                idx === messages.length - 1
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
                  <div className="chat-content">
                    {m.content}
                    {isStreaming && <span className="streaming-cursor" aria-hidden>▍</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <label>
          <span>
            {messages.length === 0
              ? 'Criteria (mood, tempo, era, must-include, avoid)'
              : 'Chat with the AI'}
          </span>
          <textarea
            rows={messages.length === 0 ? 4 : 2}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter inserts a newline. Matches the
              // chat-style convention; multi-line refinements still
              // possible when you really need them.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (!generating && theme.trim()) void handleSuggest()
              }
            }}
            placeholder={
              messages.length === 0
                ? "e.g. upbeat opener, slower communion song, include 'Cornerstone'"
                : "e.g. drop the upbeat ones, give me two slower options for the closer, swap candidate X for something newer"
            }
          />
        </label>
        <div className="row">
          <button
            className="ai-button"
            onClick={() => void handleSuggest()}
            disabled={generating || !theme.trim()}
          >
            <span className="sparkle" aria-hidden>✨</span>
            {generating
              ? 'Thinking…'
              : messages.length === 0
                ? 'Suggest songs'
                : 'Send'}
          </button>
          {(candidates.length > 0 || messages.length > 0) && (
            <button
              className="ghost"
              onClick={clearCandidates}
              disabled={generating}
              title="Wipe all AI suggestions and the chat history for this plan. Committed songs in Planning Center are not affected — the AI will start the next turn fresh, using only what's in PCO."
            >
              Clear conversation
            </button>
          )}
        </div>
        {generateError && <div className="error">Error: {generateError}</div>}
        </div>
      </section>

      {(() => {
        const rejected = candidates.filter((c) => c.decision === 'reject')
        if (rejected.length === 0) return null
        // needsAttention: rejected, no reason saved, picker not
        // dismissed → render with picker visible, in a stack so the
        // user can address them in any order.
        // done: rejected with a saved reason OR explicitly dismissed
        // → collapsed pool below.
        const needsAttention = rejected.filter(
          (c) => !c.rejectReason && !c.rejectPickerDismissed,
        )
        const done = rejected.filter(
          (c) => c.rejectReason || c.rejectPickerDismissed,
        )

        // Shared rationale-picker render. `mode` distinguishes the
        // two contexts: 'fresh' is a needs-attention card (Skip
        // dismisses to done); 'edit' is a done card being modified
        // (Skip cancels edit, leaving any existing reason intact).
        const renderPicker = (
          c: CandidateMatch,
          mode: 'fresh' | 'edit',
        ) => (
          <div className="rationale-picker">
            <div className="rationale-header">
              <span className="rationale-question">
                Why did you reject this?
              </span>
              <button
                type="button"
                className="rationale-skip"
                onClick={() =>
                  mode === 'fresh'
                    ? dismissRejectPicker(c.id)
                    : cancelEditingReason(c.id)
                }
                title={
                  mode === 'fresh'
                    ? 'Hide this picker — moves the card to the rejected pool below without saving a reason'
                    : 'Cancel edit — leaves the saved reason unchanged'
                }
              >
                Skip
              </button>
            </div>
            {reasonChips.length > 0 && (
              <div className="rationale-chips">
                {reasonChips.map((chip) => (
                  <span key={chip.text} className="rationale-chip">
                    <button
                      type="button"
                      className="rationale-chip-text"
                      onClick={() => {
                        setCandidateReason(c.id, chip.text)
                        bumpReasonSignal()
                      }}
                      title="Use this reason"
                    >
                      {chip.text}
                    </button>
                    <button
                      type="button"
                      className="rationale-chip-remove"
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeReasonChip(chip.text)
                      }}
                      title="Remove this chip from the global list"
                      aria-label={`Remove "${chip.text}" from common reasons`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="rationale-freeform">
              <textarea
                className="rationale-input"
                placeholder="Or type your own reason… (the AI will use it on the next suggestion)"
                rows={2}
                value={reasonDrafts[c.id] ?? ''}
                onChange={(e) =>
                  setReasonDrafts((prev) => ({
                    ...prev,
                    [c.id]: e.target.value,
                  }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    const draft = reasonDrafts[c.id] ?? ''
                    void saveFreeformReason(c.id, draft)
                  }
                }}
              />
              <button
                type="button"
                className="rationale-save"
                onClick={() => {
                  const draft = reasonDrafts[c.id] ?? ''
                  void saveFreeformReason(c.id, draft)
                }}
                disabled={!(reasonDrafts[c.id] ?? '').trim()}
              >
                Save
              </button>
            </div>
          </div>
        )

        return (
          <>
            {needsAttention.length > 0 && (
              <ul className="rejected-needs-reason-list">
                {needsAttention.map((c) => (
                  <li
                    key={c.id}
                    className="rejected-card rejected-needs-reason"
                  >
                    <div className="rejected-title">
                      “{c.suggestion.title}”
                      {c.suggestion.author && (
                        <span className="author"> — {c.suggestion.author}</span>
                      )}
                    </div>
                    {c.suggestion.chorusSnippet && (
                      <div className="rejected-snippet">
                        “{c.suggestion.chorusSnippet}”
                      </div>
                    )}
                    {renderPicker(c, 'fresh')}
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
            )}
            {done.length > 0 && (
              <details
                className="rejected-pool"
                open={rejectedPoolOpen}
                onToggle={(e) => setRejectedPoolOpen(e.currentTarget.open)}
              >
                <summary>
                  <span className="chevron" aria-hidden>▸</span>
                  <span>{done.length} rejected</span>
                </summary>
                <ul className="rejected-list">
                  {done.map((c) => {
                    const isEditing = rationaleFocusId === c.id
                    return (
                      <li key={c.id} className="rejected-card">
                        <div className="rejected-title">
                          {c.suggestion.title}
                          {c.suggestion.author && (
                            <span className="author">
                              {' '}
                              — {c.suggestion.author}
                            </span>
                          )}
                        </div>
                        {c.suggestion.chorusSnippet && (
                          <div className="rejected-snippet">
                            “{c.suggestion.chorusSnippet}”
                          </div>
                        )}
                        {isEditing ? (
                          renderPicker(c, 'edit')
                        ) : c.rejectReason ? (
                          <div className="rejected-reason">
                            <span className="rejected-reason-label">
                              Reason:
                            </span>{' '}
                            <span className="rejected-reason-text">
                              “{c.rejectReason}”
                            </span>
                            <button
                              type="button"
                              className="rejected-reason-edit"
                              onClick={() => startEditingReason(c.id)}
                              title="Edit this reason"
                            >
                              edit
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="rejected-reason-add"
                            onClick={() => undismissRejectPicker(c.id)}
                            title="Tell the AI why you rejected this — moves the card back up to the needs-reason stack"
                          >
                            + add reason
                          </button>
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
                    )
                  })}
                </ul>
              </details>
            )}
          </>
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
            <span className="provider-tag">via {AI_PROVIDER_LABEL}</span>
          </h3>
          <ul>
            {active.map((c) => {
              const matched = c.matchStatus === 'matched' && c.song
              const candidateDraggable = !!matched && !c.committedAt
              const candidateBeingDragged =
                dragKind === 'candidate' && dragSourceId === c.id
              return (
                <li
                  key={c.id}
                  className={`candidate match-${c.matchStatus} decision-${c.decision}${
                    candidateDraggable ? ' is-draggable' : ''
                  }${candidateBeingDragged ? ' is-dragging' : ''}`}
                  draggable={candidateDraggable || undefined}
                  onDragStart={(e) => {
                    if (!candidateDraggable) return
                    // text/plain keeps Firefox happy; the real payload
                    // lives in dragKind + dragSourceId.
                    e.dataTransfer.setData('text/plain', c.id)
                    e.dataTransfer.effectAllowed = 'move'
                    suppressNativeDragImage(e)
                    setDragKind('candidate')
                    setDragSourceId(c.id)
                    setDragGhost({
                      label: c.suggestion.title,
                      sub: c.suggestion.author ?? null,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }}
                  onDragEnd={endDrag}
                >
                  <div className="ctitle">
                    {matched ? (
                      <a
                        className="ctitle-link"
                        href={`https://services.planningcenteronline.com/songs/${c.song!.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open in Planning Center"
                        draggable={false}
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
                          (() => {
                            const recent = playedWithinDays(
                              c.song!.lastScheduledAt,
                              28,
                            )
                            return (
                              <span
                                className={`last-played${recent ? ' last-played-recent' : ''}`}
                                title={
                                  recent
                                    ? `Played ${relativeTime(c.song!.lastScheduledAt)} — recent enough that congregations may notice if you repeat it`
                                    : new Date(
                                        c.song!.lastScheduledAt,
                                      ).toLocaleString()
                                }
                              >
                                last played{' '}
                                {relativeTime(c.song!.lastScheduledAt)}
                                {c.song!.lastScheduledShortDates && (
                                  <> · {c.song!.lastScheduledShortDates}</>
                                )}
                              </span>
                            )
                          })()
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
                      draggable={false}
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
// Song slots get replaced with a meta position tag "[song slot N of M]"
// rather than their literal PCO title ("Song 1", "Closing song", etc.) so
// the model doesn't mistake those titles for slot names — slot names
// belong to the structure prompt's conceptual roles (opener, mid-service,
// closer). Position info (N of M) is preserved so the model can still
// map each position to a structure role by sequence.
function buildServiceOrderText(items: PlanItem[] | null): string {
  if (!items || items.length === 0) return ''
  const totalSongSlots = items.filter(isSongSlot).length
  let songIdx = 0
  return items
    .map((it) => {
      if (!isSongSlot(it)) {
        return `${it.sequence}. ${it.title || '(no title)'}`
      }
      songIdx += 1
      const positionTag = `[song slot ${songIdx} of ${totalSongSlots}]`
      const base = `${it.sequence}. ${positionTag}`
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

const AI_PROVIDER_LABEL = 'Claude Sonnet 4.6'

// True iff `iso` parses to a date within the last `days` days. Used to
// flag "recently played" candidates so the user can avoid repeating
// what the congregation just heard.
function playedWithinDays(iso: string, days: number): boolean {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  return Date.now() - t < days * 24 * 60 * 60 * 1000
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
