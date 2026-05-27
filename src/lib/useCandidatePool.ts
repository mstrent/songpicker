import { useCallback, useEffect, useRef, useState } from 'react'
import {
  classifySongSlots,
  enrichSnippets,
  getSong,
  loadSession,
  saveSession,
  searchSongs,
  searchSongsBatch,
  suggestSongs,
  type AiAction,
  type AiCandidate,
  type ConversationTurn,
  type Decision,
  type MatchStatus,
  type PersistedCandidate,
  type PlanItem,
  type SessionMessage,
  type Song,
  type SongSuggestion,
} from './api'
import { isSongSlot } from './songSlots'
import { translateAiAssignments } from './planActions/aiTranslate'
import {
  applyDecisionChange,
  type ApplyDecisionDeps,
} from './planActions/decisions'
import type { EvictedSong } from './planActions/resolver'
import type { PlanDataApi } from './usePlanData'

// Songpicker's candidate pool — AI-suggested songs the user is
// considering, their decisions (pending / reject), the chat log
// transcript, and the AI driver. Depends on usePlanData for items
// state (to derive "is this candidate currently in the plan?")
// and for the slot-state operation entry point (so AI tool calls
// land through the same path UI flows do).
//
// The pool is upstream of slot-filling — see CLAUDE.md
// (Architecture philosophy) and docs/unification-plan.md.

export interface CandidateMatch {
  id: string
  suggestion: SongSuggestion
  matchStatus: MatchStatus
  song?: Song
  error?: string
  decision: Decision
  addedAt: number
  /** Transient flag set when a candidate was minted from a slot
   *  eviction (not from an AI proposal). While true, the SPA is
   *  fetching enrichment data from Planning Center (lastScheduledAt
   *  etc.) and from Haiku (slot tags). The UI suppresses the time
   *  chip and slot tag chips while this is true so the card doesn't
   *  show "never played" when we just haven't loaded the data yet.
   *  Stripped from persistence — recomputed (always false) on
   *  session reload. */
  enrichmentPending?: boolean
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
    snippetSource: c.suggestion.snippetSource ?? null,
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
    // Derived state — always nulls in persistence; recomputed from
    // PCO items at render time (see Phase 6 in unification-plan.md).
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
      snippetSource:
        typeof p.snippetSource === 'string'
          ? (p.snippetSource as SongSuggestion['snippetSource'])
          : undefined,
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

const HISTORY_PROSE_CAP = 8

// How long to wait between the first getSong and the retry when the
// first response had a null lastScheduledAt. Covers PCO's
// last_scheduled_at index lag past the pcoSettled window. 3s is
// empirical — long enough to clear typical post-write staleness,
// short enough that users perceive it as "loading" not "broken."
const PCO_RETRY_MS = 3000

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
      history.push({ role: 'user', content: `[event] ${m.content}` })
    }
  }
  return history
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
        const disambParts: string[] = []
        if (it.songAuthor) disambParts.push(`by ${it.songAuthor}`)
        if (it.songCcli) disambParts.push(`CCLI ${it.songCcli}`)
        const disamb = disambParts.length > 0 ? `(${disambParts.join(', ')})` : ''
        return `${base} — picked: ${it.songTitle ?? '(song)'}${disamb ? ` ${disamb}` : ''}`
      }
      return `${base} — (empty, needs a pick)`
    })
    .join('\n')
}

export interface CandidatePoolApi {
  candidates: CandidateMatch[]
  messages: SessionMessage[]
  sessionLoaded: boolean
  criteria: string
  setCriteria: (s: string) => void
  generating: boolean
  generateError: string | null
  setGenerateError: (s: string | null) => void
  rejectedPoolOpen: boolean
  setRejectedPoolOpen: (open: boolean) => void
  handleSuggest: (opts?: { autoRefresh?: boolean }) => Promise<void>
  setDecision: (id: string, next: Decision) => void
  /** Re-run the Planning Center library lookup for a single candidate.
   *  Used when the user added the song to PCO after we first reported
   *  it as missing — flips matchStatus from `unmatched`/`error` to
   *  `matched` (with a populated `song` ref) so the normal commit
   *  path works. No-op on already-matched candidates. */
  recheckCandidate: (id: string) => void
  clearCandidates: () => void
  appendSystemMessage: (msg: string) => void
  /** True iff this candidate's matched library song is currently
   *  linked to a slot in the PCO plan. Phase 6 derived state. */
  isCandidateCommitted: (candidate: { song?: { id?: string } | null }) => boolean
  /** Ensure a song that just left the plan shows up in the active
   *  candidate pool. PlanDetail wires this to planData.setOnSongEvicted
   *  so a clear / DnD-to-suggestions / overwrite all surface the
   *  displaced song as a pending candidate the user can drag back.
   *
   *  `pcoSettled` is a promise that resolves when the executor's PCO
   *  clear has landed AND PCO's read-after-write consistency window
   *  has elapsed. ensureCandidate awaits it before firing getSong so
   *  the scheduling history we read reflects the post-clear state
   *  (otherwise PCO returns today's plan as "last scheduled"). Tests
   *  may omit it; production wires it through performIntent. */
  ensureCandidate: (evicted: EvictedSong, pcoSettled?: Promise<unknown>) => void
  reEnrichSnippet: (title: string, author: string | null) => Promise<{
    plainLyrics: string | null
    artistName: string | null
  } | null>
}

export function useCandidatePool(
  planId: string,
  planData: PlanDataApi,
): CandidatePoolApi {
  const [candidates, setCandidates] = useState<CandidateMatch[]>([])
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [criteria, setCriteria] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [rejectedPoolOpen, setRejectedPoolOpen] = useState(false)

  const autoRefineTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unservedRejectsRef = useRef(0)
  const generatingRef = useRef(false)
  const lastSentCandidateIdsRef = useRef<Set<string>>(new Set())
  const enrichInFlightRef = useRef(false)

  const triggerEnrichment = useCallback(
    async (pool: CandidateMatch[]) => {
      if (enrichInFlightRef.current) return
      const needsEnrich = pool.filter((c) => !c.suggestion.snippetSource)
      if (needsEnrich.length === 0) return

      enrichInFlightRef.current = true
      setCandidates((prev) =>
        prev.map((c) =>
          !c.suggestion.snippetSource
            ? { ...c, enrichmentPending: true }
            : c,
        ),
      )

      try {
        const res = await enrichSnippets({
          songs: needsEnrich.map((c) => ({
            title: c.song?.title ?? c.suggestion.title,
            author: c.song?.author ?? c.suggestion.author ?? undefined,
          })),
        })
        const enrichResults = res.data.results
        setCandidates((prev) =>
          prev.map((c) => {
            const idx = needsEnrich.findIndex((n) => n.id === c.id)
            if (idx === -1) return c
            if (!enrichResults[idx]) {
              return { ...c, enrichmentPending: false }
            }
            const { snippet, source } = enrichResults[idx]
            return {
              ...c,
              enrichmentPending: false,
              suggestion: {
                ...c.suggestion,
                chorusSnippet: snippet ?? undefined,
                ...(source ? { snippetSource: source } : {}),
              },
            }
          }),
        )
      } catch {
        setCandidates((prev) =>
          prev.map((c) =>
            c.enrichmentPending ? { ...c, enrichmentPending: false } : c,
          ),
        )
      } finally {
        enrichInFlightRef.current = false
      }
    },
    [],
  )

  // Wire planData's chat-log + error sinks to point at this hook's
  // setters. planData runs slot-state operations and emits
  // messages / errors, which need to land on this hook's state.
  // Using a ref-set-by-effect avoids re-creating planData's
  // executorDeps every render.
  useEffect(() => {
    planData.setAppendSystemMessage((msg: string) => {
      setMessages((prev) => [
        ...prev,
        {
          id: newCandidateId(),
          role: 'system',
          content: msg,
          timestamp: Date.now(),
        },
      ])
    })
    planData.setGenerateErrorHandler((msg: string | null) => {
      setGenerateError(msg)
    })
    // The wiring is component-stable; we only need it set once per
    // mount of this hook. planData is referentially stable across
    // renders within the same plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Plan-switch resets pool state.
  useEffect(() => {
    let cancelled = false
    // Reset all pool slices synchronously so the UI doesn't flash prior-plan
    // state before the session load resolves.
    /* eslint-disable react-hooks/set-state-in-effect */
    setCandidates([])
    setMessages([])
    setSessionLoaded(false)
    setRejectedPoolOpen(false)
    /* eslint-enable react-hooks/set-state-in-effect */
    if (autoRefineTimer.current) {
      clearTimeout(autoRefineTimer.current)
      autoRefineTimer.current = null
    }
    unservedRejectsRef.current = 0
    lastSentCandidateIdsRef.current = new Set()

    loadSession({ planId })
      .then((res) => {
        if (cancelled) return
        const loaded = res.data.candidates.map(fromPersisted)
        setCandidates(loaded)
        setMessages(res.data.messages)
        setSessionLoaded(true)
        triggerEnrichment(loaded)
      })
      .catch(() => !cancelled && setSessionLoaded(true))

    return () => {
      cancelled = true
    }
  }, [planId, triggerEnrichment])

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

  function ensureCandidate(
    evicted: EvictedSong,
    pcoSettled?: Promise<unknown>,
  ): void {
    // If we already have a candidate for this song id, leave it alone —
    // even if it's currently rejected. Re-promoting a rejected song
    // would feel like a regression; the user already decided.
    //
    // Check the closure's candidates synchronously — using a flag set
    // inside a setCandidates updater would race with React 18's queued
    // updaters (we'd read the flag before the updater runs and fire
    // the enrichment fetches unconditionally).
    if (candidates.some((c) => c.song?.id === evicted.id)) return

    const minted: CandidateMatch = {
      id: newCandidateId(),
      suggestion: {
        title: evicted.title,
        author: evicted.author ?? undefined,
      },
      matchStatus: 'matched',
      song: {
        id: evicted.id,
        title: evicted.title,
        author: evicted.author,
        ccliNumber: evicted.ccli,
        themes: null,
        isHidden: false,
        lastScheduledAt: null,
        lastScheduledShortDates: null,
      },
      decision: 'pending',
      addedAt: Date.now(),
      enrichmentPending: true,
    }
    setCandidates((prev) => {
      // Defensive — covers the rare case where two sibling calls fire
      // before either has caused a re-render (the closure check above
      // would see the stale array). Updater's prev is always live.
      if (prev.some((c) => c.song?.id === evicted.id)) return prev
      return [...prev, minted]
    })

    appendSystemMessage(`↩ "${evicted.title}" returned to candidates`)

    // Snapshot context fields at call time so concurrent renders don't
    // pull in stale or future values mid-fetch.
    const ctx = {
      theme: planData.theme,
      planNotes: planData.notesText,
      serviceOrder: buildServiceOrderText(planData.items),
    }

    // Patch helper — applies a partial update to the candidate matched
    // by song.id. No-op if the candidate has been removed since we
    // started (e.g., plan switch).
    const patchBySongId = (
      patch: (c: CandidateMatch) => CandidateMatch,
    ): void => {
      setCandidates((prev) =>
        prev.map((c) => (c.song?.id === evicted.id ? patch(c) : c)),
      )
    }

    // PCO fetch — fills lastScheduledAt + themes/ccli/etc.
    //
    // Deferred behind pcoSettled because performIntent fires us BEFORE
    // awaiting executePlan — the PCO clear write hasn't run yet at
    // this point. performIntent resolves pcoSettled after the executor
    // returns (so the clear request has gone through) plus a short
    // consistency window. Without this gating we'd always read the
    // just-cleared plan as "last scheduled today."
    //
    // pcoSettled isn't enough on its own — some songs take longer to
    // re-index than the consistency window covers, surfacing as a
    // null lastScheduledAt for a song that DOES have prior schedule
    // history. So we retry once after additional delay when the
    // first response comes back null. If the retry still says null,
    // we accept it as truth — the song genuinely has no recent
    // scheduling (or PCO truly isn't going to tell us). The UI
    // surfaces this as "no recent schedule" rather than a confident
    // "never played" lie.
    void (pcoSettled ?? Promise.resolve()).then(async () => {
      const fetchOnce = (): Promise<Song | null> =>
        getSong({ songId: evicted.id })
          .then((r) => r.data.song)
          .catch(() => null)

      let song = await fetchOnce()
      if (song && !song.lastScheduledAt) {
        // PCO's index may not have caught up yet. Wait, then try again.
        await new Promise((r) => setTimeout(r, PCO_RETRY_MS))
        const retried = await fetchOnce()
        if (retried) song = retried
      }

      // Whether we got data or not, clear the pending flag — we've
      // done our due diligence. The UI distinguishes:
      //   enrichmentPending=true → "loading history…"
      //   …=false + lastScheduledAt set → "last played X ago"
      //   …=false + lastScheduledAt null → "no recent schedule"
      patchBySongId((c) => ({
        ...c,
        song: song ?? c.song,
        enrichmentPending: false,
      }))
    })

    classifySongSlots({
      planId,
      songTitle: evicted.title,
      songAuthor: evicted.author ?? undefined,
      songCcli: evicted.ccli ?? undefined,
      theme: ctx.theme,
      planNotes: ctx.planNotes,
      serviceOrder: ctx.serviceOrder,
    })
      .then((r) => {
        const { slots } = r.data
        if (slots.length === 0) return
        patchBySongId((c) => ({
          ...c,
          suggestion: {
            ...c.suggestion,
            slots,
          },
        }))
      })
      .catch(() => {})
  }

  function isCandidateCommitted(candidate: {
    song?: { id?: string } | null
  }): boolean {
    const id = candidate.song?.id
    if (!id) return false
    for (const it of planData.items ?? []) {
      if (it.songId === id) return true
    }
    return false
  }

  function committedSongIdsSet(): Set<string> {
    const out = new Set<string>()
    for (const it of planData.items ?? []) {
      if (it.songId) out.add(it.songId)
    }
    return out
  }

  function decisionDeps(opts: {
    withRejectSignal: boolean
  }): ApplyDecisionDeps {
    return {
      candidates,
      setCandidates: (update) =>
        setCandidates((prev) => update(prev) as CandidateMatch[]),
      appendSystemMessage,
      committedSongIds: committedSongIdsSet(),
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

  /** Library-match lookup for a batch of freshly-proposed
   *  candidates. One Cloud Function round-trip; the server fans out
   *  PCO calls under bounded concurrency. Pairs results back to
   *  candidates by index. On error, every candidate in the batch
   *  gets matchStatus='error'. */
  function attachLibraryMatchesBatch(
    minted: readonly CandidateMatch[],
  ): void {
    if (minted.length === 0) return
    const queries = minted.map((c) => ({
      query: c.suggestion.title,
      ...(c.suggestion.author ? { author: c.suggestion.author } : {}),
    }))
    searchSongsBatch({ queries })
      .then((sr) => {
        const results = sr.data.results
        const updates = new Map<string, Partial<CandidateMatch>>()
        for (let i = 0; i < minted.length; i++) {
          const c = minted[i]
          const songs = results[i]
          if (songs === null) {
            updates.set(c.id, { matchStatus: 'unmatched' as MatchStatus })
            continue
          }
          const match = songs[0]
          updates.set(
            c.id,
            match
              ? { matchStatus: 'matched' as MatchStatus, song: match }
              : { matchStatus: 'unmatched' as MatchStatus },
          )
        }
        setCandidates((prev) =>
          prev.map((cur) => {
            const u = updates.get(cur.id)
            return u ? { ...cur, ...u } : cur
          }),
        )
      })
      .catch((e: Error) => {
        const ids = new Set(minted.map((c) => c.id))
        setCandidates((prev) =>
          prev.map((cur) =>
            ids.has(cur.id)
              ? { ...cur, matchStatus: 'error' as MatchStatus, error: e.message }
              : cur,
          ),
        )
      })
  }

  // Per-candidate library re-check. The user clicked "Re-check" on a
  // row that came back unmatched (or errored); they've since added
  // the song in Planning Center and want us to look again. Re-uses
  // the existing `searchSongs` callable — no new function-side
  // surface — and the debounced session save persists the new
  // matchStatus/song.
  function recheckCandidate(id: string): void {
    const target = candidates.find((c) => c.id === id)
    if (!target) return
    // Already matched? Nothing useful to do.
    if (target.matchStatus === 'matched') return
    // Avoid stacking concurrent rechecks on the same row.
    if (target.matchStatus === 'checking') return
    setCandidates((prev) =>
      prev.map((cur) =>
        cur.id === id
          ? { ...cur, matchStatus: 'checking' as MatchStatus, error: undefined }
          : cur,
      ),
    )
    searchSongs({
      query: target.suggestion.title,
      ...(target.suggestion.author ? { author: target.suggestion.author } : {}),
    })
      .then((res) => {
        const match = res.data.songs[0]
        setCandidates((prev) =>
          prev.map((cur) =>
            cur.id === id
              ? match
                ? { ...cur, matchStatus: 'matched' as MatchStatus, song: match, error: undefined }
                : { ...cur, matchStatus: 'unmatched' as MatchStatus, error: undefined }
              : cur,
          ),
        )
      })
      .catch((e: Error) => {
        setCandidates((prev) =>
          prev.map((cur) =>
            cur.id === id
              ? { ...cur, matchStatus: 'error' as MatchStatus, error: e.message }
              : cur,
          ),
        )
      })
  }

  async function handleSuggest(opts?: {
    autoRefresh?: boolean
  }): Promise<void> {
    const autoRefresh = opts?.autoRefresh === true
    if (!planData.theme.trim() || generating) return
    if (autoRefineTimer.current) {
      clearTimeout(autoRefineTimer.current)
      autoRefineTimer.current = null
    }
    setGenerating(true)
    setGenerateError(null)

    const turnUserMessage = autoRefresh ? '' : criteria
    if (!autoRefresh) setCriteria('')

    let assistantMsgId: string | null = null

    try {
      const items = planData.items
      const songSlotItems = (items ?? []).filter(isSongSlot)
      const totalSongSlots = songSlotItems.length
      const slotIndexBySongId = new Map<string, number>()
      songSlotItems.forEach((it, idx) => {
        if (it.songId) slotIndexBySongId.set(it.songId, idx + 1)
      })

      const aiCandidates: AiCandidate[] = candidates.map((c) => {
        const slotIndex = c.song?.id
          ? slotIndexBySongId.get(c.song.id)
          : undefined
        return {
          id: c.id,
          title: c.suggestion.title,
          author: c.suggestion.author,
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

      const candidateSongIds = new Set(
        candidates.filter((c) => c.song?.id).map((c) => c.song!.id),
      )
      const alreadyInPlan = (items ?? [])
        .filter(
          (it) =>
            it.songId && it.songTitle && !candidateSongIds.has(it.songId),
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
            attachLibraryMatchesBatch(minted)
            for (const c of minted) {
              lastSentCandidateIdsRef.current.add(c.id)
            }
            appendSystemMessage(
              `🤖 AI proposed ${minted.length} new song${minted.length === 1 ? '' : 's'}`,
            )
            triggerEnrichment(minted)
          }
        } else if (action.kind === 'remove') {
          const result = applyDecisionChange(
            { ids: action.ids, decision: 'reject' },
            'ai',
            decisionDeps({ withRejectSignal: false }),
          )
          if (result.changedIds.length > 0) setRejectedPoolOpen(true)
        } else if (action.kind === 'set_slot_contents') {
          // Translate AI's candidate-id assignments into the
          // song-ref shape the unified path expects, then forward
          // to planData.performIntent. See planActions/aiTranslate
          // for the rules + tests.
          const { assignments, warnings } = translateAiAssignments(
            action.assignments,
            candidates,
          )
          for (const w of warnings) appendSystemMessage(`⚠ ${w}`)
          const result = await planData.performIntent(assignments, {
            source: 'ai',
            deferRefresh: true,
            autoRefresh,
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
        theme: planData.theme,
        userMessage: turnUserMessage,
        planId,
        serviceOrder,
        planNotes: planData.notesText,
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
          await planData.refreshPlanState()
        } catch {
          // Refresh is best-effort.
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

  async function reEnrichSnippet(
    title: string,
    author: string | null,
  ): Promise<{ plainLyrics: string | null; artistName: string | null } | null> {
    const titleLower = title.toLowerCase()
    setCandidates((prev) =>
      prev.map((c) => {
        const cTitle = (c.song?.title ?? c.suggestion.title).toLowerCase()
        if (cTitle !== titleLower) return c
        return { ...c, enrichmentPending: true }
      }),
    )
    try {
      const res = await enrichSnippets({
        songs: [{ title, author: author ?? undefined }],
        forceRefresh: true,
      })
      const r = res.data.results[0]
      if (!r) return null
      setCandidates((prev) =>
        prev.map((c) => {
          const cTitle = (c.song?.title ?? c.suggestion.title).toLowerCase()
          if (cTitle !== titleLower) return c
          return {
            ...c,
            enrichmentPending: false,
            suggestion: {
              ...c.suggestion,
              chorusSnippet: r.snippet ?? undefined,
              ...(r.source ? { snippetSource: r.source } : {}),
            },
          }
        }),
      )
      return { plainLyrics: r.plainLyrics, artistName: r.artistName }
    } catch {
      setCandidates((prev) =>
        prev.map((c) =>
          c.enrichmentPending ? { ...c, enrichmentPending: false } : c,
        ),
      )
      return null
    }
  }

  return {
    candidates,
    messages,
    sessionLoaded,
    criteria,
    setCriteria,
    generating,
    generateError,
    setGenerateError,
    rejectedPoolOpen,
    setRejectedPoolOpen,
    handleSuggest,
    setDecision,
    recheckCandidate,
    clearCandidates,
    appendSystemMessage,
    isCandidateCommitted,
    ensureCandidate,
    reEnrichSnippet,
  }
}
