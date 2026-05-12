import React, { useEffect, useRef, useState } from 'react'
import {
  clearSongFromSlot,
  getRejectionReasons,
  loadSession,
  placeSongInSlot,
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
  /** Transient SPA-only flag set true the moment we optimistically
   *  flip committedAt during an AI commit, and cleared once the
   *  post-PCO items refresh lands. The reconciliation effect skips
   *  pending candidates so it doesn't see "new committedAt vs.
   *  pre-refresh items" and wrongly reset the commit. Never
   *  persisted — defaults to false on session load. */
  commitPending: boolean
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
    commitPending: false,
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
  // Candidate ids that were sent to the AI on the most recent
  // suggestSongs call (manual or auto-refresh). Used to compact the
  // candidates block — once the AI has seen a candidate's full info
  // (especially the chorus snippet, the heaviest field), subsequent
  // turns can omit it. Resets to empty on page load, which means a
  // session resumed after closing the tab re-introduces all
  // candidates with full data on the first turn (intentional — the
  // AI is effectively "rebooting" its understanding of the pool).
  const lastSentCandidateIdsRef = useRef<Set<string>>(new Set())

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
    lastSentCandidateIdsRef.current = new Set()

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
      // Skip candidates whose commit is still in-flight — items
      // probably hasn't refreshed yet, so the slot.songId check
      // below would flag them stale and wipe a successful commit.
      // commitPending clears in the same render as setItems(fresh)
      // after the PCO write completes, so this gate naturally
      // releases on the next reconciliation pass.
      if (c.commitPending) continue
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

    // Hoisted so the catch block can find the placeholder it inserted
    // (when something goes wrong before the stream produces text) and
    // replace its content with an inline error notice.
    let assistantMsgId: string | null = null

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

      // Compact the candidates payload: candidates the AI already saw
      // on the previous turn drop their chorusSnippet (the only large
      // stable field). Title + author still go on every turn so the
      // AI can disambiguate songs that share a title. Mutable fields
      // (decision, committed, assignedSlot, rejectReason) always sent.
      const knownCandidateIds = lastSentCandidateIdsRef.current
      const aiCandidates: AiCandidate[] = candidates.map((c) => {
        const slotIndex = c.assignedSlotItemId
          ? slotIndexByItemId.get(c.assignedSlotItemId)
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
      const history: ConversationTurn[] = buildAiHistory(messages)

      // Pre-allocate an id for the placeholder assistant message so
      // stream chunks can find it to append into. Manual sends also
      // prepend a user message; auto-refresh prepends a system
      // marker instead so the chat log shows the AI is reacting on
      // its own rather than to a (nonexistent) typed turn.
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
      // Per-turn PCO write plan. We BUFFER commits and clears here
      // instead of firing them per-action — that lets a swap (two
      // commits whose target slots are each other's source) land
      // cleanly. Phase 1 clears all sources, Phase 2 commits all
      // targets. PCO PATCH is idempotent on songId/title so the
      // commit phase overwrites whatever's at the target slot.
      //
      // The Map keys deliberately collapse duplicates: only the LAST
      // commit per slot survives, and a clear gets dropped if a
      // commit later targets the same slot (the commit's PATCH
      // would overwrite the cleared state anyway).
      const plannedClears = new Map<
        string,
        { slotItem: PlanItem; restoreTitle: string }
      >()
      const plannedCommits = new Map<
        string,
        {
          candidateId: string
          songId: string
          songTitle: string
          rollback: () => void
        }
      >()
      // Live tracker: where each committed candidate currently is,
      // including in-flight optimistic updates from earlier actions
      // in this same turn. Used so action N+1 sees the effect of
      // action N when deciding isMove / source / eviction.
      const liveCommittedSlot = new Map<string, string>()
      candidates.forEach((c) => {
        if (c.committedAt && c.assignedSlotItemId) {
          liveCommittedSlot.set(c.id, c.assignedSlotItemId)
        }
      })
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
              commitPending: false,
            }
            minted.push(c)
            titleById.set(c.id, c.suggestion.title)
          }
          if (minted.length > 0) {
            setCandidates((prev) => [...prev, ...minted])
            minted.forEach(searchAndAttachSong)
            // Newly-proposed candidates count as "AI has seen these"
            // for the next turn's payload-compaction check — the AI
            // just emitted them with full data, no need to send them
            // back with the chorus snippet attached again next time.
            for (const c of minted) {
              lastSentCandidateIdsRef.current.add(c.id)
            }
            appendSystemMessage(
              `🤖 AI proposed ${minted.length} new song${minted.length === 1 ? '' : 's'}`,
            )
          }
        } else if (action.kind === 'remove') {
          // Filter to candidates we'll actually reject: not committed
          // (committed songs can't be rejected without first clearing
          // the slot, and rejecting a song the AI is about to displace
          // is almost always a "replace" misinterpretation anyway) and
          // not already rejected.
          const actuallyRejectedIds: string[] = []
          setCandidates((prev) =>
            prev.map((c) => {
              if (
                action.ids.includes(c.id) &&
                !c.committedAt &&
                c.decision !== 'reject'
              ) {
                actuallyRejectedIds.push(c.id)
                return { ...c, decision: 'reject', rejectReason: action.reason }
              }
              return c
            }),
          )
          if (actuallyRejectedIds.length > 0) {
            const titles = actuallyRejectedIds
              .map((id) => titleById.get(id) ?? `(unknown ${id})`)
              .join(', ')
            appendSystemMessage(
              `🤖 AI rejected ${titles} — reason: "${action.reason}"`,
            )
            setRejectedPoolOpen(true)
          }
          // If none of the targets were eligible, stay silent — don't
          // emit a "rejected" message that didn't actually happen.
          // This is typically the AI misreading "remove X, replace
          // with Y" as a rejection + commit (it's just displacement).
        } else if (action.kind === 'set_slot_contents') {
          if (autoRefresh) {
            appendSystemMessage(
              `⚠ AI tried to change song slots during auto-refresh — skipped (Planning Center writes require explicit direction)`,
            )
            return
          }
          // Build a set of all song titles known to the SPA — candidates,
          // their matched songs, and any songs currently committed in
          // the service order. We use this as a taint detector: a
          // priorSlotTitle matching any of these is almost certainly a
          // stale song name (the slot's title got overwritten on commit
          // and then was preserved through later moves/swaps as a
          // "prior"). True placeholder names like "Song 1" or
          // "Communion song" won't appear in this set so they survive.
          const knownSongTitlesLower = new Set<string>()
          for (const c of candidates) {
            const t = c.suggestion.title.trim().toLowerCase()
            if (t) knownSongTitlesLower.add(t)
            const st = c.song?.title?.trim().toLowerCase()
            if (st) knownSongTitlesLower.add(st)
          }
          for (const it of items ?? []) {
            const st = it.songTitle?.trim().toLowerCase()
            if (st) knownSongTitlesLower.add(st)
          }
          const isTaintedTitle = (t: string | null | undefined): boolean => {
            const trimmed = t?.trim()
            if (!trimmed) return false
            return knownSongTitlesLower.has(trimmed.toLowerCase())
          }

          // Pre-turn snapshot of slot placeholder identities. For each
          // currently-committed candidate, capture the slot's original
          // placeholder name. Incoming commits in this turn inherit
          // from this map so a swap doesn't lose the placeholder.
          // Skip any entries whose priorSlotTitle is tainted (matches
          // any known song title) — those got overwritten in a prior
          // turn and shouldn't propagate further.
          const preTurnSlotPlaceholders = new Map<string, string>()
          for (const c of candidates) {
            if (
              c.committedAt &&
              c.assignedSlotItemId &&
              c.priorSlotTitle &&
              c.priorSlotTitle.trim() &&
              !isTaintedTitle(c.priorSlotTitle)
            ) {
              preTurnSlotPlaceholders.set(
                c.assignedSlotItemId,
                c.priorSlotTitle.trim(),
              )
            }
          }
          // Validate + resolve each assignment up front. Invalid ones
          // get a ⚠ marker and drop out of the plan.
          type ResolvedCommit = {
            kind: 'commit'
            slotItemId: string
            slotIndex: number
            slotItem: PlanItem
            candidate: CandidateMatch
            songId: string
            songTitle: string
          }
          type ResolvedClear = {
            kind: 'clear'
            slotItemId: string
            slotIndex: number
            slotItem: PlanItem
          }
          const resolved: Array<ResolvedCommit | ResolvedClear> = []
          for (const a of action.assignments) {
            const slotItemId = itemIdBySlotIndex.get(a.slotIndex)
            if (!slotItemId) {
              appendSystemMessage(
                `⚠ AI tried to set song slot ${a.slotIndex}, but no such slot exists — skipped`,
              )
              continue
            }
            const slotItem = (items ?? []).find((it) => it.id === slotItemId)
            if (!slotItem) continue
            if (a.candidateId == null) {
              resolved.push({
                kind: 'clear',
                slotItemId,
                slotIndex: a.slotIndex,
                slotItem,
              })
              continue
            }
            const candidate = preTurnCandidatesById.get(a.candidateId)
            if (!candidate) {
              appendSystemMessage(
                `⚠ AI referenced an unknown candidate (${a.candidateId}) — skipped`,
              )
              continue
            }
            if (!candidate.song?.id) {
              appendSystemMessage(
                `⚠ AI tried to place "${candidate.suggestion.title}" but it isn't matched to a song in your Planning Center library — skipped`,
              )
              continue
            }
            resolved.push({
              kind: 'commit',
              slotItemId,
              slotIndex: a.slotIndex,
              slotItem,
              candidate,
              songId: candidate.song.id,
              songTitle: candidate.suggestion.title,
            })
          }
          if (resolved.length === 0) return

          // Detect swap pairs across the resolved commits: assignment X
          // puts A in slot α while another assignment Y puts B in slot
          // β AND A was currently at β AND B was currently at α. We
          // emit one combined "swapped" system message per pair rather
          // than two "moved" lines.
          const swapPartnerIndex = new Map<number, number>()
          for (let i = 0; i < resolved.length; i++) {
            if (swapPartnerIndex.has(i)) continue
            const ri = resolved[i]
            if (ri.kind !== 'commit') continue
            const iCurrent = liveCommittedSlot.get(ri.candidate.id)
            if (iCurrent === undefined || iCurrent === ri.slotItemId) continue
            for (let j = i + 1; j < resolved.length; j++) {
              if (swapPartnerIndex.has(j)) continue
              const rj = resolved[j]
              if (rj.kind !== 'commit') continue
              const jCurrent = liveCommittedSlot.get(rj.candidate.id)
              if (jCurrent === undefined || jCurrent === rj.slotItemId) continue
              if (jCurrent === ri.slotItemId && iCurrent === rj.slotItemId) {
                swapPartnerIndex.set(i, j)
                swapPartnerIndex.set(j, i)
                break
              }
            }
          }

          // Apply each resolved entry: optimistic state + plan PCO ops
          // + emit a system message (one combined per swap pair).
          const emittedSwapMessageFor = new Set<number>()
          for (let i = 0; i < resolved.length; i++) {
            const r = resolved[i]
            if (r.kind === 'clear') {
              // Snapshot for rollback: any committed candidate at this
              // slot we're about to evict.
              const occupant = candidates.find(
                (c) =>
                  c.assignedSlotItemId === r.slotItemId && c.committedAt != null,
              )
              // Restore title: prefer the occupant's stored prior
              // (preserves any user-customized slot name like
              // "Communion song"). Fall back to the position-based
              // "Song N" if the stored prior is missing OR if it
              // matches ANY known song title — that means a previous
              // commit/move/swap tainted the prior, in which case
              // "Song N" is at least correct rather than wrong.
              const storedPrior = occupant?.priorSlotTitle?.trim()
              const restoreTitle =
                (!isTaintedTitle(storedPrior) && storedPrior) ||
                fallbackSlotTitle(r.slotItemId)
              const songTitle =
                occupant?.suggestion.title ?? r.slotItem.songTitle ?? 'song'
              setCandidates((prev) =>
                prev.map((c) =>
                  c.assignedSlotItemId === r.slotItemId
                    ? {
                        ...c,
                        committedAt: null,
                        assignedSlotItemId: null,
                        priorSlotTitle: null,
                      }
                    : c,
                ),
              )
              for (const [id, slot] of [...liveCommittedSlot.entries()]) {
                if (slot === r.slotItemId) liveCommittedSlot.delete(id)
              }
              plannedClears.set(r.slotItemId, {
                slotItem: r.slotItem,
                restoreTitle,
              })
              pcoWritesFired = true
              appendSystemMessage(
                `🤖 AI cleared "${songTitle}" from song slot ${r.slotIndex}`,
              )
              continue
            }
            // Commit (fresh / move / overwrite / swap-half)
            const candidate = r.candidate
            const targetItemId = r.slotItemId
            const songId = r.songId
            const songTitle = r.songTitle
            const currentSlot = liveCommittedSlot.get(candidate.id)
            const isMove =
              currentSlot !== undefined && currentSlot !== targetItemId
            const fromSlotIndex =
              isMove && currentSlot
                ? slotIndexByItemId.get(currentSlot) ?? null
                : null
            // Rollback snapshots for both this candidate and any
            // evicted previous occupant of the target slot.
            let rollbackForCandidate:
              | {
                  id: string
                  decision: typeof candidate.decision
                  committedAt: number | null
                  assignedSlotItemId: string | null
                  priorSlotTitle: string | null
                }
              | null = null
            let evictedRollback:
              | {
                  id: string
                  committedAt: number | null
                  assignedSlotItemId: string | null
                  priorSlotTitle: string | null
                }
              | null = null
            setCandidates((prev) => {
              const me = prev.find((c) => c.id === candidate.id)
              if (me) {
                rollbackForCandidate = {
                  id: me.id,
                  decision: me.decision,
                  committedAt: me.committedAt,
                  assignedSlotItemId: me.assignedSlotItemId,
                  priorSlotTitle: me.priorSlotTitle,
                }
              }
              const evicted = prev.find(
                (c) =>
                  c.id !== candidate.id &&
                  c.assignedSlotItemId === targetItemId &&
                  c.committedAt != null,
              )
              if (evicted) {
                evictedRollback = {
                  id: evicted.id,
                  committedAt: evicted.committedAt,
                  assignedSlotItemId: evicted.assignedSlotItemId,
                  priorSlotTitle: evicted.priorSlotTitle,
                }
              }
              // Inherit the slot's original placeholder from the
              // pre-turn snapshot if we have one. Fall back to the
              // slot's current title only when there was no prior
              // committed candidate (i.e., fresh commit to a slot
              // whose title still IS the placeholder).
              const newPriorSlotTitle =
                preTurnSlotPlaceholders.get(targetItemId) ??
                r.slotItem.title ??
                null
              return prev.map((c) => {
                if (c.id === candidate.id) {
                  return {
                    ...c,
                    committedAt: now,
                    assignedSlotItemId: targetItemId,
                    priorSlotTitle: newPriorSlotTitle,
                    commitPending: true,
                  }
                }
                if (
                  c.assignedSlotItemId === targetItemId &&
                  c.committedAt != null &&
                  c.id !== candidate.id
                ) {
                  return {
                    ...c,
                    committedAt: null,
                    assignedSlotItemId: null,
                    priorSlotTitle: null,
                  }
                }
                return c
              })
            })
            if (isMove && currentSlot) {
              const restoreTitle =
                candidate.priorSlotTitle?.trim() ||
                fallbackSlotTitle(currentSlot)
              const slotItemForClear = (items ?? []).find(
                (it) => it.id === currentSlot,
              )
              if (slotItemForClear) {
                plannedClears.set(currentSlot, {
                  slotItem: slotItemForClear,
                  restoreTitle,
                })
              }
            }
            plannedCommits.set(targetItemId, {
              candidateId: candidate.id,
              songId,
              songTitle,
              rollback: () => {
                setCandidates((prev) =>
                  prev.map((c) => {
                    if (
                      rollbackForCandidate &&
                      c.id === rollbackForCandidate.id
                    ) {
                      return {
                        ...c,
                        decision: rollbackForCandidate.decision,
                        committedAt: rollbackForCandidate.committedAt,
                        assignedSlotItemId:
                          rollbackForCandidate.assignedSlotItemId,
                        priorSlotTitle: rollbackForCandidate.priorSlotTitle,
                        commitPending: false,
                      }
                    }
                    if (evictedRollback && c.id === evictedRollback.id) {
                      return {
                        ...c,
                        committedAt: evictedRollback.committedAt,
                        assignedSlotItemId: evictedRollback.assignedSlotItemId,
                        priorSlotTitle: evictedRollback.priorSlotTitle,
                      }
                    }
                    return c
                  }),
                )
              },
            })
            for (const [id, slot] of [...liveCommittedSlot.entries()]) {
              if (slot === targetItemId && id !== candidate.id) {
                liveCommittedSlot.delete(id)
              }
            }
            liveCommittedSlot.set(candidate.id, targetItemId)
            pcoWritesFired = true

            // System message: one combined "swapped" for swap pairs,
            // otherwise per-assignment commit / move.
            const partner = swapPartnerIndex.get(i)
            if (partner !== undefined) {
              if (!emittedSwapMessageFor.has(i)) {
                const other = resolved[partner]
                if (other.kind === 'commit') {
                  appendSystemMessage(
                    `🤖 AI swapped "${songTitle}" and "${other.songTitle}"`,
                  )
                  emittedSwapMessageFor.add(i)
                  emittedSwapMessageFor.add(partner)
                }
              }
            } else {
              appendSystemMessage(
                isMove
                  ? `🤖 AI moved "${songTitle}" from song slot ${fromSlotIndex ?? '?'} to song slot ${r.slotIndex}`
                  : `🤖 AI committed "${songTitle}" to song slot ${r.slotIndex}`,
              )
            }
          }
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

      // Mark all candidates we just sent as "AI has seen these" so
      // subsequent turns can compact their payload (drop the chorus
      // snippet). The stream below will append new candidates via
      // propose actions; we add their ids to this set as they arrive
      // so the NEXT turn knows about them too. Update here at send
      // time rather than after the stream so a mid-stream error
      // still records what was sent.
      lastSentCandidateIdsRef.current = new Set(
        aiCandidates.map((c) => c.id),
      )

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
            m.id === newAssistantMsgId ? { ...m, content: final.message } : m,
          ),
        )
      }
      // Execute the planned PCO writes in two phases. Phase 1 clears
      // every involved source slot; Phase 2 commits all targets.
      // This order is what makes swaps work — clearing both A's
      // source and B's source before committing either prevents one
      // commit from clobbering the other. Drop clears for slots
      // that are also commit targets in this same turn (the commit's
      // PATCH overwrites the slot anyway, so a separate clear is
      // wasted PCO traffic).
      if (pcoWritesFired) {
        for (const slotId of plannedCommits.keys()) {
          plannedClears.delete(slotId)
        }
        // Phase 1: clears
        for (const [slotItemId, { restoreTitle }] of plannedClears) {
          try {
            await clearSongFromSlot({
              serviceTypeId,
              planId,
              slotItemId,
              restoreTitle,
            })
          } catch (e) {
            const err = e as Error
            appendSystemMessage(
              `⚠ Clear failed for a slot — ${err.message}`,
            )
          }
        }
        // Phase 2: commits. No fromSlotItemId because phase 1 has
        // already cleared whatever sources needed clearing.
        for (const [
          slotItemId,
          { songId, songTitle, rollback },
        ] of plannedCommits) {
          try {
            await placeSongInSlot({
              serviceTypeId,
              planId,
              slotItemId,
              songId,
              songTitle,
            })
          } catch (e) {
            const err = e as Error
            rollback()
            appendSystemMessage(
              `⚠ AI commit failed for "${songTitle}" — ${err.message}`,
            )
          }
        }
      }
      // Single items refresh after the turn — picks up commits, clears,
      // title restorations all in one PCO read. Clear commitPending in
      // the same React render as setItems(fresh) so the reconciliation
      // effect sees both updates together (per CLAUDE.md: setItems
      // before setCandidates batches them into a single render with
      // consistent state).
      if (pcoWritesFired) {
        invalidatePlanContext(serviceTypeId, planId)
        try {
          const fresh = await loadPlanContext(serviceTypeId, planId)
          setItems(fresh.items)
          setCandidates((prev) =>
            prev.map((c) =>
              c.commitPending ? { ...c, commitPending: false } : c,
            ),
          )
        } catch {
          // Items refresh is best-effort. Leave commitPending set —
          // if items didn't refresh, the reconciliation effect
          // would still see stale items and wipe the commit. Better
          // to keep the optimistic state visible than to flicker.
        }
      }
    } catch (e) {
      const errMsg = (e as Error).message
      setGenerateError(errMsg)
      // Replace the empty assistant placeholder with an inline error
      // message so the chat log doesn't leave a blank AI bubble next
      // to the error notice. Only when nothing streamed in — if
      // partial text arrived, keep it.
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
    // Reset the "AI has seen these candidates" tracker so the next
    // Suggest call re-introduces any remaining candidates with full
    // info. Clearing the conversation effectively wipes the AI's
    // memory of what's been said, so we need to give it full intros
    // again.
    lastSentCandidateIdsRef.current = new Set()
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
        // Un-rejection wipes any stored reason AND any "Skip dismissed"
        // flag — the candidate is back in play, both bits of reject
        // state no longer apply. Committed candidates keep their
        // assignedSlotItemId (that's the live PCO commit) regardless
        // of decision flips.
        const clearReject = newDecision !== 'reject'
        return {
          ...c,
          decision: newDecision,
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

  // Unified action layer for PCO write intents. Both user-driven
  // flows (DnD, slot pickers) and AI-driven flows (commit_song /
  // clear_slot tool calls) go through these three helpers. Each
  // handles: optimistic state update, the Cloud Function call,
  // optional items refresh (deferred for AI batching), failure
  // rollback, and the chat-log system message. Source: 'user' vs
  // 'ai' only affects message formatting.

  async function placeSongAction(opts: {
    candidate: CandidateMatch
    slotItem: PlanItem
    source?: 'user' | 'ai'
    deferRefresh?: boolean
  }): Promise<void> {
    const { candidate, slotItem } = opts
    const source = opts.source ?? 'user'
    const deferRefresh = opts.deferRefresh ?? false
    if (!candidate.song?.id) {
      const msg =
        source === 'ai'
          ? `⚠ AI tried to commit "${candidate.suggestion.title}" but it isn't matched to a song in your Planning Center library — skipped`
          : `⚠ Can't commit "${candidate.suggestion.title}" — no matching song in your Planning Center library`
      appendSystemMessage(msg)
      return
    }
    const songId = candidate.song.id
    const songTitle = candidate.suggestion.title
    // Move semantics: clear old slot first if the candidate is
    // currently committed elsewhere. The Cloud Function handles the
    // clear+commit chain atomically server-side.
    const isMove =
      candidate.committedAt != null &&
      candidate.assignedSlotItemId != null &&
      candidate.assignedSlotItemId !== slotItem.id
    const fromSlotItemId = isMove ? candidate.assignedSlotItemId : undefined
    const fromSlotRestoreTitle =
      isMove && fromSlotItemId
        ? candidate.priorSlotTitle?.trim() || fallbackSlotTitle(fromSlotItemId)
        : undefined
    const fromSlotIndex =
      isMove && fromSlotItemId
        ? (items ?? [])
            .filter(isSongSlot)
            .findIndex((it) => it.id === fromSlotItemId) + 1
        : null
    const slotIndex =
      (items ?? []).filter(isSongSlot).findIndex((it) => it.id === slotItem.id) + 1
    const slotLabel = slotItem.title || fallbackSlotTitle(slotItem.id)
    const newPriorSlotTitle = slotItem.title ?? null
    const rollbackSnapshot = {
      decision: candidate.decision,
      committedAt: candidate.committedAt,
      assignedSlotItemId: candidate.assignedSlotItemId,
      priorSlotTitle: candidate.priorSlotTitle,
    }
    // Optimistic flip. commitPending shields the candidate from the
    // reconciliation effect until items refreshes (see CLAUDE.md note
    // on the batching pattern).
    setCandidates((prev) =>
      prev.map((c) =>
        c.id === candidate.id
          ? {
              ...c,
              committedAt: Date.now(),
              assignedSlotItemId: slotItem.id,
              priorSlotTitle: newPriorSlotTitle,
              commitPending: true,
            }
          : c,
      ),
    )
    if (source === 'ai') {
      appendSystemMessage(
        isMove
          ? `🤖 AI moved "${songTitle}" from song slot ${fromSlotIndex ?? '?'} to song slot ${slotIndex}`
          : `🤖 AI committed "${songTitle}" to song slot ${slotIndex}`,
      )
    } else {
      appendSystemMessage(
        isMove
          ? `↕ Moved "${songTitle}" → ${slotLabel}`
          : `↗ Committed "${songTitle}" → ${slotLabel}`,
      )
    }
    try {
      await placeSongInSlot({
        serviceTypeId,
        planId,
        slotItemId: slotItem.id,
        songId,
        songTitle,
        ...(fromSlotItemId ? { fromSlotItemId } : {}),
        ...(fromSlotRestoreTitle ? { fromSlotRestoreTitle } : {}),
      })
      if (!deferRefresh) {
        invalidatePlanContext(serviceTypeId, planId)
        const fresh = await loadPlanContext(serviceTypeId, planId)
        setItems(fresh.items)
        setCandidates((prev) =>
          prev.map((c) =>
            c.id === candidate.id ? { ...c, commitPending: false } : c,
          ),
        )
      }
      // When deferred (AI batched flow), the caller's post-stream
      // cleanup is responsible for the items refresh + clearing
      // commitPending. Leaving commitPending=true here is correct.
    } catch (e) {
      const err = e as Error
      setCandidates((prev) =>
        prev.map((c) =>
          c.id === candidate.id
            ? { ...c, ...rollbackSnapshot, commitPending: false }
            : c,
        ),
      )
      const failMsg =
        source === 'ai'
          ? `⚠ AI ${isMove ? 'move' : 'commit'} failed for "${songTitle}" — ${err.message}`
          : `⚠ ${isMove ? 'Move' : 'Commit'} failed for "${songTitle}" — ${err.message}`
      appendSystemMessage(failMsg)
      if (source === 'user') {
        setGenerateError(err.message)
      }
    }
  }

  async function clearSlotAction(opts: {
    slotItem: PlanItem
    source?: 'user' | 'ai'
    deferRefresh?: boolean
  }): Promise<void> {
    const { slotItem } = opts
    const source = opts.source ?? 'user'
    const deferRefresh = opts.deferRefresh ?? false
    if (!slotItem.songId) return
    const slotIndex =
      (items ?? []).filter(isSongSlot).findIndex((it) => it.id === slotItem.id) + 1
    // Prefer the title captured at commit time; fall back to the
    // "Song N" convention so the slot label doesn't keep the song
    // name after clearing. Reject the stored prior when it matches
    // ANY known song title (the slot's stored "prior" was tainted by
    // a previous move/swap and would restore to a song name).
    const committedCandidate = candidates.find(
      (c) => c.assignedSlotItemId === slotItem.id && c.committedAt != null,
    )
    const knownSongTitlesLower = new Set<string>()
    for (const c of candidates) {
      const t = c.suggestion.title.trim().toLowerCase()
      if (t) knownSongTitlesLower.add(t)
      const st = c.song?.title?.trim().toLowerCase()
      if (st) knownSongTitlesLower.add(st)
    }
    for (const it of items ?? []) {
      const st = it.songTitle?.trim().toLowerCase()
      if (st) knownSongTitlesLower.add(st)
    }
    const storedPrior = committedCandidate?.priorSlotTitle?.trim()
    const priorIsTainted =
      !!(storedPrior && knownSongTitlesLower.has(storedPrior.toLowerCase()))
    const restoreTitle =
      (!priorIsTainted && storedPrior) || fallbackSlotTitle(slotItem.id)
    const songTitle =
      committedCandidate?.suggestion.title ?? slotItem.songTitle ?? '(song)'
    const rollbackByCandidate = new Map(
      candidates
        .filter((c) => c.assignedSlotItemId === slotItem.id && c.committedAt)
        .map((c) => [
          c.id,
          {
            committedAt: c.committedAt,
            assignedSlotItemId: c.assignedSlotItemId,
            priorSlotTitle: c.priorSlotTitle,
          },
        ]),
    )
    setCandidates((prev) =>
      prev.map((c) =>
        c.assignedSlotItemId === slotItem.id
          ? {
              ...c,
              assignedSlotItemId: null,
              committedAt: null,
              priorSlotTitle: null,
            }
          : c,
      ),
    )
    if (source === 'ai') {
      appendSystemMessage(
        `🤖 AI cleared "${songTitle}" from song slot ${slotIndex}`,
      )
    } else {
      appendSystemMessage(
        `↶ Cleared "${songTitle}" from ${restoreTitle}`,
      )
    }
    try {
      await clearSongFromSlot({
        serviceTypeId,
        planId,
        slotItemId: slotItem.id,
        restoreTitle,
      })
      if (!deferRefresh) {
        invalidatePlanContext(serviceTypeId, planId)
        const fresh = await loadPlanContext(serviceTypeId, planId)
        setItems(fresh.items)
      }
    } catch (e) {
      const err = e as Error
      setCandidates((prev) =>
        prev.map((c) => {
          const snap = rollbackByCandidate.get(c.id)
          return snap ? { ...c, ...snap } : c
        }),
      )
      const failMsg =
        source === 'ai'
          ? `⚠ AI clear failed for song slot ${slotIndex} — ${err.message}`
          : `⚠ Clear failed for ${restoreTitle} — ${err.message}`
      appendSystemMessage(failMsg)
      if (source === 'user') {
        setGenerateError(err.message)
      }
    }
  }

  async function swapSlotsAction(opts: {
    slotA: PlanItem
    slotB: PlanItem
    source?: 'user' | 'ai'
  }): Promise<void> {
    const { slotA, slotB } = opts
    const source = opts.source ?? 'user'
    const order = (items ?? []).map((it) => it.id)
    const aIdx = order.indexOf(slotA.id)
    const bIdx = order.indexOf(slotB.id)
    if (aIdx === -1 || bIdx === -1) return
    const newOrder = [...order]
    newOrder[aIdx] = slotB.id
    newOrder[bIdx] = slotA.id
    const aLabel = slotA.songTitle ?? slotA.title ?? 'slot'
    const bLabel = slotB.songTitle ?? slotB.title ?? 'slot'
    if (source === 'ai') {
      appendSystemMessage(`🤖 AI swapped "${aLabel}" with "${bLabel}"`)
    } else {
      appendSystemMessage(`↔ Swapped "${aLabel}" with "${bLabel}"`)
    }
    try {
      await reorderItemsCall({
        serviceTypeId,
        planId,
        orderedItemIds: newOrder,
      })
      // Apply the swap locally rather than refetching. PCO's
      // read-after-write on item_reorder can return the pre-swap
      // ordering for a beat — that's what was leaving the UI showing
      // the old positions until a manual reload caught up. We know
      // exactly what the post-swap state looks like (same items, two
      // positions traded, their sequence values traded with them),
      // so we apply it directly and bust the cache so a later
      // navigate-away-and-back picks up fresh data from PCO.
      setItems((prev) => {
        if (!prev) return prev
        const ai = prev.findIndex((it) => it.id === slotA.id)
        const bi = prev.findIndex((it) => it.id === slotB.id)
        if (ai === -1 || bi === -1) return prev
        const a = prev[ai]
        const b = prev[bi]
        const next = [...prev]
        next[ai] = { ...b, sequence: a.sequence }
        next[bi] = { ...a, sequence: b.sequence }
        return next
      })
      invalidatePlanContext(serviceTypeId, planId)
      const affected = new Set([slotA.id, slotB.id])
      setCandidates((prev) =>
        prev.map((c) =>
          c.assignedSlotItemId && affected.has(c.assignedSlotItemId)
            ? { ...c, priorSlotTitle: null }
            : c,
        ),
      )
    } catch (e) {
      const err = e as Error
      const failMsg =
        source === 'ai'
          ? `⚠ AI swap failed — ${err.message}`
          : `⚠ Swap failed — ${err.message}`
      appendSystemMessage(failMsg)
      if (source === 'user') {
        setGenerateError(err.message)
      }
    }
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
      // Empty target → move the dragged slot's song into it. If the
      // SPA has a candidate record for the source's commit, route
      // through placeSongAction so the candidate's committedAt /
      // assignedSlotItemId / priorSlotTitle migrate cleanly. If not
      // (e.g. the song was picked directly in PCO), call the
      // intent-shaped endpoint with raw song info and rely on the
      // post-call items refresh to sync state.
      const committedCand = candidates.find(
        (c) =>
          c.assignedSlotItemId === draggedSlot.id &&
          c.committedAt != null &&
          c.song,
      )
      if (committedCand) {
        await placeSongAction({ candidate: committedCand, slotItem: targetSlot })
      } else {
        if (!draggedSlot.songId || !draggedSlot.songTitle) {
          setGenerateError(
            `Can't move "${draggedSlot.songTitle ?? draggedSlot.title}" — missing song info on the source slot.`,
          )
          return
        }
        const sourceRestoreTitle =
          draggedSlot.title?.trim() || fallbackSlotTitle(draggedSlot.id)
        const songTitle = draggedSlot.songTitle
        const destLabel =
          targetSlot.title?.trim() || fallbackSlotTitle(targetSlot.id)
        try {
          await placeSongInSlot({
            serviceTypeId,
            planId,
            slotItemId: targetSlot.id,
            songId: draggedSlot.songId,
            songTitle,
            fromSlotItemId: draggedSlot.id,
            fromSlotRestoreTitle: sourceRestoreTitle,
          })
          invalidatePlanContext(serviceTypeId, planId)
          const fresh = await loadPlanContext(serviceTypeId, planId)
          setItems(fresh.items)
          appendSystemMessage(`↕ Moved "${songTitle}" → ${destLabel}`)
        } catch (e) {
          setGenerateError((e as Error).message)
        }
      }
    } else {
      await swapSlotsAction({ slotA: draggedSlot, slotB: targetSlot })
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
              const slot = (items ?? []).find((it) => it.id === dragSourceId)
              if (slot) void clearSlotAction({ slotItem: slot })
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
                      const candidate = candidates.find(
                        (c) => c.id === dragSourceId,
                      )
                      if (candidate && !it.songId) {
                        void placeSongAction({
                          candidate,
                          slotItem: it,
                        })
                      }
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
                            onClick={() => void clearSlotAction({ slotItem: it })}
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
        // Active = not-rejected. Rejected ones get tucked into the
        // collapsed disclosure below to reduce clutter. Committed
        // candidates stay in the active list too, just with the
        // committed-badge instead of the slot picker.
        const active = candidates.filter((c) => c.decision !== 'reject')
        const emptySongSlots = (items ?? []).filter(
          (it) => isSongSlot(it) && !it.songId,
        )

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

                    {matched && c.committedAt && (
                      // Service order on the left is the source of
                      // truth for WHICH slot. Showing a slot label
                      // here was nonsensical anyway — PCO overwrites
                      // the slot's title with the song name on commit.
                      <span className="committed-badge">✓ Committed</span>
                    )}

                    {matched && !c.committedAt && (() => {
                      // Empty slot picker commits directly on selection
                      // — no intermediate "earmarked but not committed"
                      // state since we dropped shortlist.
                      const avail = emptySongSlots
                      return (
                        <select
                          className="slot-picker"
                          value=""
                          disabled={avail.length === 0}
                          onChange={(e) => {
                            const slotId = e.target.value
                            if (!slotId) return
                            const slot = avail.find((s) => s.id === slotId)
                            if (!slot) return
                            void placeSongAction({ candidate: c, slotItem: slot })
                          }}
                          title={
                            avail.length === 0
                              ? 'No empty song slots available'
                              : 'Commit to slot'
                          }
                        >
                          <option value="">
                            {avail.length === 0
                              ? 'No open slots'
                              : 'Commit to slot…'}
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

// Cap on how many user/assistant prose turn-pairs we keep verbatim
// in the AI's history. Older prose turns drop entirely; older
// `[event]` system markers get collapsed into a single counts-only
// summary at the top of the history. 8 prose messages ≈ 4 turn-pairs.
const HISTORY_PROSE_CAP = 8

// Convert a SessionMessage[] into the ConversationTurn[] shape the AI
// receives, with two-tier pruning so a long-running session doesn't
// blow up the per-turn token count. Recent prose + recent events go
// verbatim; older content collapses into a `[summary]` line.
function buildAiHistory(messages: SessionMessage[]): ConversationTurn[] {
  const proseCount = messages.filter((m) => m.role !== 'system').length
  if (proseCount <= HISTORY_PROSE_CAP) {
    return foldMessagesToHistory(messages)
  }
  // Find the cutoff: the earliest message we keep verbatim. Walk
  // back from the end, counting prose turns, until we've gathered
  // HISTORY_PROSE_CAP of them. Everything before that is "old".
  let proseFound = 0
  let cutoff = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'system') proseFound += 1
    if (proseFound >= HISTORY_PROSE_CAP) {
      cutoff = i
      break
    }
  }
  const oldMessages = messages.slice(0, cutoff)
  const recentMessages = messages.slice(cutoff)
  const out = foldMessagesToHistory(recentMessages)
  const summary = summarizeOldEvents(oldMessages)
  if (summary) {
    out.unshift({ role: 'user', content: `[summary] ${summary}` })
  }
  return out
}

function foldMessagesToHistory(
  messages: SessionMessage[],
): ConversationTurn[] {
  return messages.map((m) =>
    m.role === 'system'
      ? { role: 'user' as const, content: `[event] ${m.content}` }
      : { role: m.role, content: m.content },
  )
}

// Compress a slice of old messages into a single counts-only line.
// Pattern-matches the system message prefixes we emit (✗ Rejected,
// 🤖 AI committed, ↗ Committed, etc.) so the categories stay stable
// across user/AI/reconciliation event sources. Specifics
// (which songs, which slots, exact reasons) are deliberately dropped —
// the current candidates block + service order already convey the
// state that matters; this summary is just orientation for the AI
// that "stuff happened earlier" without re-sending every event.
function summarizeOldEvents(messages: SessionMessage[]): string {
  const events = messages.filter((m) => m.role === 'system')
  if (events.length === 0) return ''
  let rejected = 0
  let unrejected = 0
  let committed = 0
  let moved = 0
  let swapped = 0
  let cleared = 0
  let proposed = 0
  for (const e of events) {
    const c = e.content
    if (/^✗ Rejected:/.test(c) || /AI rejected/.test(c)) rejected += 1
    else if (/^↩ Unrejected:/.test(c) || /AI restored/.test(c)) unrejected += 1
    else if (/AI committed|^↗ Committed/.test(c)) committed += 1
    else if (/AI moved|^↕ Moved/.test(c)) moved += 1
    else if (/AI swapped|^↔ Swapped/.test(c)) swapped += 1
    else if (/AI cleared|^↶ Cleared/.test(c)) cleared += 1
    else if (/AI proposed/.test(c)) {
      const match = /AI proposed (\d+)/.exec(c)
      proposed += match ? parseInt(match[1], 10) : 1
    }
  }
  const parts: string[] = []
  if (proposed) parts.push(`${proposed} song${proposed === 1 ? '' : 's'} proposed`)
  if (rejected) parts.push(`${rejected} rejected`)
  if (unrejected) parts.push(`${unrejected} restored`)
  if (committed) parts.push(`${committed} committed to slot${committed === 1 ? '' : 's'}`)
  if (moved) parts.push(`${moved} moved`)
  if (swapped) parts.push(`${swapped} swap${swapped === 1 ? '' : 's'}`)
  if (cleared) parts.push(`${cleared} slot${cleared === 1 ? '' : 's'} cleared`)
  if (parts.length === 0) return ''
  return `Earlier in this session: ${parts.join(', ')}.`
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
