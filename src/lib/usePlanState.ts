import { useEffect, useRef, useState } from 'react'
import {
  clearSongFromSlot,
  loadSession,
  placeSongInSlot,
  saveSession,
  savePlanNotes,
  savePlanTheme,
  searchSongs,
  suggestSongs,
  type AiAction,
  type AiCandidate,
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
} from './api'
import {
  invalidatePlanContext,
  loadPlanContext,
  patchCachedNotes,
  patchCachedTheme,
} from './cache'
import { isSongSlot } from './songSlots'
import {
  applyDecisionChange,
  type ApplyDecisionDeps,
} from './planActions/decisions'
import {
  resolvePlan,
  type Assignment,
} from './planActions/resolver'
import {
  executePlan,
  type ExecutorDeps,
} from './planActions/executor'
import {
  compileSlotToSlot,
} from './planActions/compile'
import {
  fallbackSlotTitle as fallbackSlotTitleHelper,
} from './planActions/helpers'

// SPA-internal candidate shape. Phase 6 dropped committedAt /
// assignedSlotItemId / priorSlotTitle / commitPending — those were
// derived/transient state that drifted from PCO. The candidate now
// just carries: identity, the AI's suggestion, optional matched
// library song, decision (pending|reject), and a few timestamps /
// errors. "Is this candidate currently committed?" is computed by
// the UI from items.songId === candidate.song?.id.
export interface CandidateMatch {
  id: string
  suggestion: SongSuggestion
  matchStatus: MatchStatus
  song?: Song
  error?: string
  decision: Decision
  addedAt: number
}

function newCandidateId(): string {
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
      c.matchStatus === 'checking' ? 'unmatched' : c.matchStatus,
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
    // Phase 6: assignedSlotItemId / committedAt / priorSlotTitle
    // are no longer on CandidateMatch. Persistence keeps them in
    // the schema (PersistedCandidate is shared with the Cloud
    // Function) but always writes nulls — values are derived from
    // PCO state at load time.
    assignedSlotItemId: null,
    committedAt: null,
    priorSlotTitle: null,
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
  }
}

function formatNotesSource(notes: readonly PlanNote[]): string {
  if (!notes || notes.length === 0) return ''
  return notes
    .filter((n) => n.content && n.content.trim())
    .map((n) =>
      n.category ? `[${n.category}] ${n.content.trim()}` : n.content.trim(),
    )
    .join('\n\n')
}

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

const HISTORY_PROSE_CAP = 8

interface SystemEventBucket {
  proposed: number
  rejected: number
  unrejected: number
  committed: number
  cleared: number
  moved: number
  swapped: number
  other: number
}

function summarizeOldEvents(events: SessionMessage[]): string {
  const b: SystemEventBucket = {
    proposed: 0,
    rejected: 0,
    unrejected: 0,
    committed: 0,
    cleared: 0,
    moved: 0,
    swapped: 0,
    other: 0,
  }
  for (const e of events) {
    const c = e.content
    if (/proposed/i.test(c)) b.proposed++
    else if (/rejected/i.test(c)) b.rejected++
    else if (/unrejected|restored/i.test(c)) b.unrejected++
    else if (/committed/i.test(c)) b.committed++
    else if (/cleared|clear/i.test(c)) b.cleared++
    else if (/moved/i.test(c)) b.moved++
    else if (/swapped/i.test(c)) b.swapped++
    else b.other++
  }
  const parts: string[] = []
  if (b.proposed) parts.push(`${b.proposed} proposed`)
  if (b.rejected) parts.push(`${b.rejected} rejected`)
  if (b.unrejected) parts.push(`${b.unrejected} unrejected`)
  if (b.committed) parts.push(`${b.committed} committed`)
  if (b.cleared) parts.push(`${b.cleared} cleared`)
  if (b.moved) parts.push(`${b.moved} moved`)
  if (b.swapped) parts.push(`${b.swapped} swapped`)
  if (b.other) parts.push(`${b.other} other`)
  return parts.length > 0 ? `[summary] ${parts.join(', ')}` : ''
}

function buildAiHistory(messages: SessionMessage[]): ConversationTurn[] {
  const proseMessages = messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  )
  const systemMessages = messages.filter((m) => m.role === 'system')
  const recentProse = proseMessages.slice(-HISTORY_PROSE_CAP)
  const droppedSystemEvents = systemMessages.filter((m) => {
    const recentProseFirstTs = recentProse[0]?.timestamp ?? Infinity
    return m.timestamp < recentProseFirstTs
  })
  const recentSystemEvents = systemMessages.filter((m) => {
    const recentProseFirstTs = recentProse[0]?.timestamp ?? Infinity
    return m.timestamp >= recentProseFirstTs
  })
  const summary = summarizeOldEvents(droppedSystemEvents)
  const history: ConversationTurn[] = []
  if (summary) {
    history.push({ role: 'user', content: summary })
  }
  const merged = [...recentProse, ...recentSystemEvents].sort(
    (a, b) => a.timestamp - b.timestamp,
  )
  for (const m of merged) {
    if (m.role === 'user') {
      history.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      history.push({ role: 'assistant', content: m.content })
    } else {
      // system events render as a plain user-side note in history
      history.push({ role: 'user', content: `[event] ${m.content}` })
    }
  }
  return history
}

export interface PlanStateApi {
  // Loaded
  plan: Plan | null
  notes: PlanNote[] | null
  items: PlanItem[] | null
  slotPlaceholders: Record<string, string>
  loadError: string | null
  // Per-plan editable
  theme: string
  themeSource: string
  notesText: string
  notesSource: string
  criteria: string
  // Pool
  candidates: CandidateMatch[]
  messages: SessionMessage[]
  sessionLoaded: boolean
  // Status
  generating: boolean
  generateError: string | null
  rejectedPoolOpen: boolean
  // Setters intended for UI
  setTheme: (s: string) => void
  setNotesText: (s: string) => void
  setCriteria: (s: string) => void
  setRejectedPoolOpen: (open: boolean) => void
  setGenerateError: (s: string | null) => void
  /** Reset to the Planning Center source value AND immediately
   *  clear the saved override server-side (rather than waiting on
   *  the debounced auto-save). */
  resetTheme: () => void
  resetNotes: () => void
  // Actions
  handleSuggest: (opts?: { autoRefresh?: boolean }) => Promise<void>
  performUiAction: (assignments: readonly Assignment[]) => Promise<void>
  reorderSlotItem: (draggedId: string, targetId: string) => Promise<void>
  setDecision: (id: string, next: Decision) => void
  clearCandidates: () => void
  appendSystemMessage: (msg: string) => void
  /** Used by ArrangementKeyEditor's onSaved callback. */
  refreshPlanState: () => Promise<void>
  /** Position-based "Song N" fallback bound to current items. */
  fallbackSlotTitle: (itemId: string) => string
  /** True when the AI is mid-stream — used to disable inputs. */
  isGenerating: boolean
  /** True iff this candidate's matched library song is currently
   *  linked to a slot in the PCO plan. Phase 6 derived state — the
   *  candidate doesn't store this; we look it up on every render. */
  isCandidateCommitted: (candidate: { song?: { id?: string } | null }) => boolean
}

export function usePlanState(
  serviceTypeId: string,
  planId: string,
): PlanStateApi {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [notes, setNotes] = useState<PlanNote[] | null>(null)
  const [items, setItems] = useState<PlanItem[] | null>(null)
  const [slotPlaceholders, setSlotPlaceholders] = useState<
    Record<string, string>
  >({})
  const [loadError, setLoadError] = useState<string | null>(null)

  const [themeRaw, setThemeRaw] = useState('')
  const [themeSource, setThemeSource] = useState('')
  const [notesTextRaw, setNotesTextRaw] = useState('')
  const [notesSource, setNotesSource] = useState('')
  const [criteria, setCriteria] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<CandidateMatch[]>([])
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [rejectedPoolOpen, setRejectedPoolOpen] = useState(false)

  const themeInitialized = useRef(false)
  const notesInitialized = useRef(false)
  const userTouchedTheme = useRef(false)
  const userTouchedNotes = useRef(false)
  const autoRefineTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unservedRejectsRef = useRef(0)
  const generatingRef = useRef(false)
  const lastSentCandidateIdsRef = useRef<Set<string>>(new Set())

  // Public setters that mark touched + trigger auto-save effect.
  function setTheme(value: string): void {
    userTouchedTheme.current = true
    setThemeRaw(value)
  }
  function setNotesText(value: string): void {
    userTouchedNotes.current = true
    setNotesTextRaw(value)
  }

  function resetTheme(): void {
    userTouchedTheme.current = true
    setThemeRaw(themeSource)
    patchCachedTheme(serviceTypeId, planId, '')
    void savePlanTheme({ planId, theme: '' }).catch(() => {})
  }
  function resetNotes(): void {
    userTouchedNotes.current = true
    setNotesTextRaw(notesSource)
    patchCachedNotes(serviceTypeId, planId, '')
    void savePlanNotes({ planId, notes: '' }).catch(() => {})
  }

  // Plan + session load (re-runs on plan switch). Resets every piece
  // of per-plan state so a stale value from the prior plan can't
  // leak into the new one.
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
    setRejectedPoolOpen(false)
    if (autoRefineTimer.current) {
      clearTimeout(autoRefineTimer.current)
      autoRefineTimer.current = null
    }
    unservedRejectsRef.current = 0
    lastSentCandidateIdsRef.current = new Set()

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
        setSlotPlaceholders(ctx.slotPlaceholders)
        const themeSrc = ctx.plan.seriesTitle ?? ctx.plan.title ?? ''
        setThemeSource(themeSrc)
        const notesSrc = formatNotesSource(ctx.notes)
        setNotesSource(notesSrc)
        if (!themeInitialized.current) {
          const saved = ctx.userTheme
          setThemeRaw(saved && saved.trim() ? saved : themeSrc)
          themeInitialized.current = true
        }
        if (!notesInitialized.current) {
          const saved = ctx.userNotes
          setNotesTextRaw(saved && saved.trim() ? saved : notesSrc)
          notesInitialized.current = true
        }
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))

    return () => {
      cancelled = true
    }
  }, [serviceTypeId, planId])

  useEffect(() => {
    generatingRef.current = generating
  }, [generating])

  // Debounced session save.
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

  // (Phase 6 deleted the reconciliation effect that used to compare
  // candidates' committedAt to items.songId. Candidate "committed
  // status" is now derived on every render from items.songId, so
  // there's no per-candidate state to drift out of sync.)

  // Auto-save theme/notes on change.
  useEffect(() => {
    if (!userTouchedTheme.current) return
    const id = setTimeout(() => {
      const value = themeRaw === themeSource ? '' : themeRaw
      patchCachedTheme(serviceTypeId, planId, value)
      void savePlanTheme({ planId, theme: value }).catch(() => {})
    }, 600)
    return () => clearTimeout(id)
  }, [themeRaw, themeSource, serviceTypeId, planId])

  useEffect(() => {
    if (!userTouchedNotes.current) return
    const id = setTimeout(() => {
      const value = notesTextRaw === notesSource ? '' : notesTextRaw
      patchCachedNotes(serviceTypeId, planId, value)
      void savePlanNotes({ planId, notes: value }).catch(() => {})
    }, 600)
    return () => clearTimeout(id)
  }, [notesTextRaw, notesSource, serviceTypeId, planId])

  async function refreshPlanState(): Promise<void> {
    invalidatePlanContext(serviceTypeId, planId)
    const fresh = await loadPlanContext(serviceTypeId, planId)
    setItems(fresh.items)
    setSlotPlaceholders(fresh.slotPlaceholders)
  }

  function fallbackSlotTitle(itemId: string): string {
    return fallbackSlotTitleHelper(itemId, items)
  }

  function appendSystemMessage(content: string): void {
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

  function searchAndAttachSong(c: CandidateMatch): void {
    searchSongs({
      query: c.suggestion.title,
      ...(c.suggestion.author ? { author: c.suggestion.author } : {}),
    })
      .then((sr) => {
        const match = sr.data.songs[0]
        setCandidates((prev) =>
          prev.map((cur) =>
            cur.id === c.id
              ? match
                ? { ...cur, matchStatus: 'matched' as MatchStatus, song: match }
                : { ...cur, matchStatus: 'unmatched' as MatchStatus }
              : cur,
          ),
        )
      })
      .catch((e: Error) => {
        setCandidates((prev) =>
          prev.map((cur) =>
            cur.id === c.id
              ? { ...cur, matchStatus: 'error' as MatchStatus, error: e.message }
              : cur,
          ),
        )
      })
  }

  function executorDepsForCurrent(): ExecutorDeps {
    return {
      serviceTypeId,
      planId,
      pco: { placeSongInSlot, clearSongFromSlot },
      setItems,
      appendSystemMessage,
      refreshPlanState,
    }
  }

  async function performUiAction(
    assignments: readonly Assignment[],
  ): Promise<void> {
    if (assignments.length === 0) return
    const plan = resolvePlan(assignments as Assignment[], {
      items: items ?? [],
      slotPlaceholders,
    })
    await executePlan(plan, executorDepsForCurrent(), { source: 'user' })
  }

  function committedSongIds(): Set<string> {
    const out = new Set<string>()
    for (const it of items ?? []) {
      if (it.songId) out.add(it.songId)
    }
    return out
  }

  function isCandidateCommitted(candidate: {
    song?: { id?: string } | null
  }): boolean {
    const id = candidate.song?.id
    if (!id) return false
    for (const it of items ?? []) {
      if (it.songId === id) return true
    }
    return false
  }

  function decisionDeps(opts: {
    withRejectSignal: boolean
  }): ApplyDecisionDeps {
    return {
      setCandidates: (update) =>
        setCandidates((prev) => update(prev) as CandidateMatch[]),
      appendSystemMessage,
      committedSongIds: committedSongIds(),
      onRejectsLanded: opts.withRejectSignal
        ? (n) => {
            for (let i = 0; i < n; i++) bumpRejectSignal()
          }
        : undefined,
    }
  }

  function setDecision(id: string, next: Decision): void {
    const target = candidates.find((c) => c.id === id)
    if (!target) return
    const decision: Decision = target.decision === next ? 'pending' : next
    applyDecisionChange(
      { ids: [id], decision: decision === 'reject' ? 'reject' : 'pending' },
      'user',
      decisionDeps({ withRejectSignal: true }),
    )
  }

  function scheduleAutoRefine(): void {
    if (autoRefineTimer.current) clearTimeout(autoRefineTimer.current)
    autoRefineTimer.current = setTimeout(() => {
      autoRefineTimer.current = null
      if (generatingRef.current) return
      if (unservedRejectsRef.current < 2) return
      void handleSuggest({ autoRefresh: true })
    }, 5000)
  }

  function bumpRejectSignal(): void {
    unservedRejectsRef.current += 1
    scheduleAutoRefine()
  }

  function clearCandidates(): void {
    setCandidates([])
    setMessages([])
    lastSentCandidateIdsRef.current = new Set()
    if (autoRefineTimer.current) {
      clearTimeout(autoRefineTimer.current)
      autoRefineTimer.current = null
    }
    unservedRejectsRef.current = 0
  }

  async function reorderSlotItem(
    draggedId: string,
    targetId: string,
  ): Promise<void> {
    if (draggedId === targetId) return
    const draggedSlot = (items ?? []).find((it) => it.id === draggedId)
    const targetSlot = (items ?? []).find((it) => it.id === targetId)
    if (!draggedSlot || !targetSlot) return

    // Phase 6: compileSlotToSlot operates on items.songId only —
    // PCO-direct songs and candidate-tracked songs go through the
    // same path. No fallback needed for the both-filled case;
    // compile produces a swap-pair assignment that the resolver
    // and executor handle uniformly.
    const assignments = compileSlotToSlot(
      draggedSlot,
      targetSlot,
      items ?? [],
    )
    await performUiAction(assignments)
  }

  // The big AI-turn driver. Streams assistant text + tool actions
  // and executes them via the shared resolver+executor for slot
  // changes / decisions / proposals. See docs/unification-plan.md
  // and the inline comments below.
  async function handleSuggest(opts?: {
    autoRefresh?: boolean
  }): Promise<void> {
    const autoRefresh = opts?.autoRefresh === true
    if (!themeRaw.trim() || generating) return
    if (autoRefineTimer.current) {
      clearTimeout(autoRefineTimer.current)
      autoRefineTimer.current = null
    }
    setGenerating(true)
    setGenerateError(null)
    patchCachedTheme(serviceTypeId, planId, themeRaw)
    void savePlanTheme({ planId, theme: themeRaw }).catch(() => {})
    patchCachedNotes(serviceTypeId, planId, notesTextRaw)
    void savePlanNotes({ planId, notes: notesTextRaw }).catch(() => {})

    const turnUserMessage = autoRefresh ? '' : criteria
    if (!autoRefresh) setCriteria('')

    let assistantMsgId: string | null = null

    try {
      const songSlotItems = (items ?? []).filter(isSongSlot)
      const totalSongSlots = songSlotItems.length
      const slotIndexByItemId = new Map<string, number>()
      const itemIdBySlotIndex = new Map<number, string>()
      songSlotItems.forEach((it, idx) => {
        slotIndexByItemId.set(it.id, idx + 1)
        itemIdBySlotIndex.set(idx + 1, it.id)
      })

      // Phase 6: candidate "committed" status + slot assignment are
      // both derived from items at AI-payload-build time (PCO is the
      // truth, candidates are the pool). Build a song.id → slot
      // index map once; each candidate looks itself up.
      const slotIndexBySongId = new Map<string, number>()
      for (const it of items ?? []) {
        if (it.songId) {
          const idx = slotIndexByItemId.has(it.id)
            ? songSlotItems.findIndex((s) => s.id === it.id) + 1
            : 0
          if (idx > 0) slotIndexBySongId.set(it.songId, idx)
        }
      }
      const knownCandidateIds = lastSentCandidateIdsRef.current
      const aiCandidates: AiCandidate[] = candidates.map((c) => {
        const slotIndex = c.song?.id
          ? slotIndexBySongId.get(c.song.id)
          : undefined
        const isKnownToAi = knownCandidateIds.has(c.id)
        return {
          id: c.id,
          title: c.suggestion.title,
          author: c.suggestion.author,
          chorusSnippet: isKnownToAi ? undefined : c.suggestion.chorusSnippet,
          slots:
            c.suggestion.slots && c.suggestion.slots.length > 0
              ? c.suggestion.slots
              : undefined,
          decision: c.decision,
          assignedSlot:
            slotIndex !== undefined && totalSongSlots > 0
              ? { index: slotIndex, total: totalSongSlots }
              : undefined,
          committed: slotIndex !== undefined,
          inLibrary: c.matchStatus === 'matched',
        }
      })

      // Build a set of song.ids currently linked in a slot — used
      // to filter `alreadyInPlan` so the AI doesn't see items that
      // are already represented as candidates (avoids duplicate-
      // suggestion noise).
      const committedSongIds = new Set(
        candidates
          .filter((c) => c.song?.id && slotIndexBySongId.has(c.song.id))
          .map((c) => c.song!.id),
      )
      const alreadyInPlan = (items ?? [])
        .filter(
          (it) => it.songId && it.songTitle && !committedSongIds.has(it.songId),
        )
        .map((it) => it.songTitle!)

      const serviceOrder = buildServiceOrderText(items)
      const history: ConversationTurn[] = buildAiHistory(messages)

      const newAssistantMsgId = newCandidateId()
      assistantMsgId = newAssistantMsgId
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
          id: newAssistantMsgId,
          role: 'assistant',
          content: '',
          timestamp: turnTs + 1,
        },
      ])

      const titleById = new Map(
        candidates.map((c): [string, string] => [c.id, c.suggestion.title]),
      )
      let streamedText = ''
      let pcoWritesFired = false
      const executorDeps = executorDepsForCurrent()
      const existingTitlesLower = new Set(
        candidates.map((c) => c.suggestion.title.toLowerCase()),
      )

      const applyAction = async (action: AiAction): Promise<void> => {
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
            }
            minted.push(c)
            titleById.set(c.id, c.suggestion.title)
          }
          if (minted.length > 0) {
            setCandidates((prev) => [...prev, ...minted])
            minted.forEach(searchAndAttachSong)
            for (const c of minted) {
              lastSentCandidateIdsRef.current.add(c.id)
            }
            appendSystemMessage(
              `🤖 AI proposed ${minted.length} new song${minted.length === 1 ? '' : 's'}`,
            )
          }
        } else if (action.kind === 'remove') {
          const result = applyDecisionChange(
            { ids: action.ids, decision: 'reject' },
            'ai',
            decisionDeps({ withRejectSignal: false }),
          )
          if (result.changedIds.length > 0) setRejectedPoolOpen(true)
        } else if (action.kind === 'set_slot_contents') {
          // The AI's tool surface uses {slotIndex, candidateId};
          // translate to the song-ref Assignment shape the resolver
          // expects. Lookup candidate by id; pull song.id +
          // suggestion.title. Skip + warn for unmatched candidates.
          const candById = new Map(candidates.map((c) => [c.id, c]))
          const translated: Assignment[] = []
          const warnings: string[] = []
          for (const a of action.assignments) {
            if (a.candidateId == null) {
              translated.push({ slotIndex: a.slotIndex, song: null })
              continue
            }
            const c = candById.get(a.candidateId)
            if (!c) {
              warnings.push(
                `AI referenced an unknown candidate (${a.candidateId}) — skipped`,
              )
              continue
            }
            if (!c.song?.id) {
              warnings.push(
                `AI tried to commit "${c.suggestion.title}" but it isn't matched to a song in your Planning Center library — skipped`,
              )
              continue
            }
            translated.push({
              slotIndex: a.slotIndex,
              song: { id: c.song.id, title: c.suggestion.title },
            })
          }
          for (const w of warnings) appendSystemMessage(`⚠ ${w}`)
          const plan = resolvePlan(
            translated,
            { items: items ?? [], slotPlaceholders },
            { autoRefresh },
          )
          const result = await executePlan(plan, executorDeps, {
            source: 'ai',
            deferRefresh: true,
          })
          if (result.pcoWritesFired) pcoWritesFired = true
        } else if (action.kind === 'unreject') {
          applyDecisionChange(
            { ids: action.ids, decision: 'pending' },
            'ai',
            decisionDeps({ withRejectSignal: false }),
          )
        }
      }

      const { stream, data } = await suggestSongs.stream({
        theme: themeRaw,
        userMessage: turnUserMessage,
        planId,
        serviceOrder,
        planNotes: notesTextRaw,
        history,
        candidates: aiCandidates,
        alreadyInPlan,
        autoRefresh,
      })

      lastSentCandidateIdsRef.current = new Set(aiCandidates.map((c) => c.id))

      for await (const chunk of stream) {
        if (chunk.kind === 'text') {
          streamedText += chunk.delta
          setMessages((prev) =>
            prev.map((m) =>
              m.id === newAssistantMsgId
                ? { ...m, content: m.content + chunk.delta }
                : m,
            ),
          )
        } else if (chunk.kind === 'action') {
          await applyAction(chunk.action)
        }
      }

      const final = await data
      if (!streamedText.trim() && final.message) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newAssistantMsgId ? { ...m, content: final.message } : m,
          ),
        )
      }

      if (pcoWritesFired) {
        try {
          await refreshPlanState()
        } catch {
          // Refresh is best-effort. Items state still reflects
          // optimistic updates from the executor — slightly stale
          // but not incorrect.
        }
      }
    } catch (e) {
      const errMsg = (e as Error).message
      setGenerateError(errMsg)
      const placeholderId = assistantMsgId
      if (placeholderId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholderId && !m.content.trim()
              ? { ...m, content: `⚠ ${errMsg}` }
              : m,
          ),
        )
      }
    } finally {
      setGenerating(false)
      unservedRejectsRef.current = 0
    }
  }

  return {
    plan,
    notes,
    items,
    slotPlaceholders,
    loadError,
    theme: themeRaw,
    themeSource,
    notesText: notesTextRaw,
    notesSource,
    criteria,
    candidates,
    messages,
    sessionLoaded,
    generating,
    generateError,
    rejectedPoolOpen,
    setTheme,
    setNotesText,
    setCriteria,
    setRejectedPoolOpen,
    setGenerateError,
    resetTheme,
    resetNotes,
    handleSuggest,
    performUiAction,
    reorderSlotItem,
    setDecision,
    clearCandidates,
    appendSystemMessage,
    refreshPlanState,
    fallbackSlotTitle,
    isGenerating: generating,
    isCandidateCommitted,
  }
}
