import React, { useEffect, useRef, useState } from 'react'
import {
  clearSongFromSlot,
  loadSession,
  placeSongInSlot,
  reorderItems as reorderItemsCall,
  saveSession,
  savePlanNotes,
  savePlanTheme,
  searchSongs,
  suggestSongs,
  swapSlotPlaceholders as swapSlotPlaceholdersCall,
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
} from '../lib/api'
import {
  invalidatePlanContext,
  loadPlanContext,
  patchCachedNotes,
  patchCachedTheme,
} from '../lib/cache'
import { isSongSlot } from '../lib/songSlots'
import {
  buildKnownSongTitles,
  fallbackSlotTitle as fallbackSlotTitleHelper,
  findEvictionTarget,
  placeholderForSlot as placeholderForSlotHelper,
  resolveRestoreTitle,
} from '../lib/planActions/helpers'
import { resolvePlan } from '../lib/planActions/resolver'
import { usePromptConfig } from '../lib/usePromptConfig'
import { ArrangementKeyEditor } from './ArrangementKeyEditor'
import { PromptBody } from './PromptBody'
import { PromptPill } from './PromptPill'
import { Icon } from './Icon'
import { EmptyState } from './EmptyState'
import { SongLookupLinks } from './SongLookupLinks'

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
  // Persisted per-plan map of empty-slot placeholders observed in
  // PCO. Server reconciles this on every plan load (see
  // syncSlotPlaceholders), so this state is always the freshest
  // capture. Used as the highest-priority source for "what should
  // we restore the slot title to on clear?" — beats the candidate's
  // priorSlotTitle and the position-based "Song N" fallback.
  const [slotPlaceholders, setSlotPlaceholders] = useState<
    Record<string, string>
  >({})
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
  // Whether the rejected-pool <details> is open. Defaults closed; we
  // flip to true the first time the AI rejects something so the user
  // sees what just got removed without an extra click.
  const [rejectedPoolOpen, setRejectedPoolOpen] = useState(false)

  // Which candidate's "Commit to slot" menu is currently open (if any).
  // Tracked at component scope so click-outside closes it globally.
  const [openCommitMenuId, setOpenCommitMenuId] = useState<string | null>(null)
  useEffect(() => {
    if (!openCommitMenuId) return
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('.commit-menu')) return
      setOpenCommitMenuId(null)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [openCommitMenuId])

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

    setRejectedPoolOpen(false)
    // Cancel any pending auto-refine carried over from a prior plan.
    if (autoRefineTimer.current) {
      clearTimeout(autoRefineTimer.current)
      autoRefineTimer.current = null
    }
    unservedRejectsRef.current = 0
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
        setSlotPlaceholders(ctx.slotPlaceholders)
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

  // Invalidate the per-session cache, fetch fresh plan state from
  // PCO, and sync the items + slotPlaceholders React state in one
  // call. Used by every action layer function after a PCO write
  // succeeds. Forgetting to update slotPlaceholders alongside items
  // is the bug class this exists to prevent — the fields move
  // together by definition.
  async function refreshPlanState(): Promise<void> {
    invalidatePlanContext(serviceTypeId, planId)
    const fresh = await loadPlanContext(serviceTypeId, planId)
    setItems(fresh.items)
    setSlotPlaceholders(fresh.slotPlaceholders)
  }

  // Library-match lookup for a freshly-proposed candidate. Same pattern
  // we used inline before, hoisted now that propose-songs can fire from
  // multiple call sites (a single AI turn can emit multiple proposals).
  function searchAndAttachSong(c: CandidateMatch) {
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
      // (decision, committed, assignedSlot) always sent.
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
          assignedSlot:
            slotIndex !== undefined && totalSongSlots > 0
              ? { index: slotIndex, total: totalSongSlots }
              : undefined,
          committed: c.committedAt != null,
          inLibrary: c.matchStatus === 'matched',
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
                return { ...c, decision: 'reject' }
              }
              return c
            }),
          )
          if (actuallyRejectedIds.length > 0) {
            const titles = actuallyRejectedIds
              .map((id) => titleById.get(id) ?? `(unknown ${id})`)
              .join(', ')
            appendSystemMessage(`🤖 AI rejected ${titles}`)
            setRejectedPoolOpen(true)
          }
          // If none of the targets were eligible, stay silent — don't
          // emit a "rejected" message that didn't actually happen.
          // This is typically the AI misreading "remove X, replace
          // with Y" as a rejection + commit (it's just displacement).
        } else if (action.kind === 'set_slot_contents') {
          // Pure resolver does all the planning: validates assignments,
          // computes restore titles, eviction targets, swap pairs,
          // priorSlotTitle inheritance, and the move source clears.
          // The executor below just applies the Plan — optimistic
          // state, plannedClears/Commits maps, chat messages.
          // See src/lib/planActions/resolver.ts.
          const plan = resolvePlan(
            action.assignments,
            { items: items ?? [], candidates, slotPlaceholders },
            { autoRefresh },
          )
          for (const w of plan.warnings) {
            appendSystemMessage(`⚠ ${w}`)
          }
          if (plan.resolved.length === 0) return

          const emittedSwapMessageFor = new Set<number>()
          for (let i = 0; i < plan.resolved.length; i++) {
            const r = plan.resolved[i]
            if (r.kind === 'clear') {
              const songTitle =
                r.occupant?.suggestion.title ?? r.slotItem.songTitle ?? 'song'
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
              plannedClears.set(r.slotItemId, {
                slotItem: r.slotItem,
                restoreTitle: r.restoreTitle,
              })
              pcoWritesFired = true
              appendSystemMessage(
                `🤖 AI cleared "${songTitle}" from song slot ${r.slotIndex}`,
              )
              continue
            }
            // Commit (fresh / move / overwrite / swap-half)
            const candidateId = r.candidate.id
            // Rollback snapshots — captured from CURRENT state at the
            // moment of optimistic update, so a failed PCO call can
            // restore exactly what we displaced.
            let rollbackForCandidate:
              | {
                  id: string
                  decision: 'pending' | 'reject'
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
              const me = prev.find((c) => c.id === candidateId)
              if (me) {
                rollbackForCandidate = {
                  id: me.id,
                  decision: me.decision,
                  committedAt: me.committedAt,
                  assignedSlotItemId: me.assignedSlotItemId,
                  priorSlotTitle: me.priorSlotTitle,
                }
              }
              if (r.evicted) {
                const evictedNow = prev.find((c) => c.id === r.evicted!.id)
                if (evictedNow) {
                  evictedRollback = {
                    id: evictedNow.id,
                    committedAt: evictedNow.committedAt,
                    assignedSlotItemId: evictedNow.assignedSlotItemId,
                    priorSlotTitle: evictedNow.priorSlotTitle,
                  }
                }
              }
              return prev.map((c) => {
                if (c.id === candidateId) {
                  return {
                    ...c,
                    committedAt: now,
                    assignedSlotItemId: r.slotItemId,
                    priorSlotTitle: r.newPriorSlotTitle,
                    commitPending: true,
                  }
                }
                if (
                  c.assignedSlotItemId === r.slotItemId &&
                  c.committedAt != null &&
                  c.id !== candidateId
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
            if (r.isMove && r.fromSlotItem && r.fromSlotRestoreTitle) {
              plannedClears.set(r.fromSlotItem.id, {
                slotItem: r.fromSlotItem,
                restoreTitle: r.fromSlotRestoreTitle,
              })
            }
            plannedCommits.set(r.slotItemId, {
              candidateId,
              songId: r.songId,
              songTitle: r.songTitle,
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
            pcoWritesFired = true

            // System message: one combined "swapped" for swap pairs,
            // otherwise per-assignment commit / move.
            const partner = plan.swapPairs.get(i)
            if (partner !== undefined) {
              if (!emittedSwapMessageFor.has(i)) {
                const other = plan.resolved[partner]
                if (other.kind === 'commit') {
                  appendSystemMessage(
                    `🤖 AI swapped "${r.songTitle}" and "${other.songTitle}"`,
                  )
                  emittedSwapMessageFor.add(i)
                  emittedSwapMessageFor.add(partner)
                }
              }
            } else {
              appendSystemMessage(
                r.isMove
                  ? `🤖 AI moved "${r.songTitle}" from song slot ${r.fromSlotIndex ?? '?'} to song slot ${r.slotIndex}`
                  : `🤖 AI committed "${r.songTitle}" to song slot ${r.slotIndex}`,
              )
            }
          }
        } else if (action.kind === 'unreject') {
          setCandidates((prev) =>
            prev.map((c) =>
              action.ids.includes(c.id) && c.decision === 'reject'
                ? { ...c, decision: 'pending' }
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
        try {
          await refreshPlanState()
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
      // the unserved-counter so the next auto-refresh threshold
      // starts counting from zero again.
      unservedRejectsRef.current = 0
    }
  }

  function clearCandidates() {
    setCandidates([])
    setMessages([])
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
  }

  // 5-second debounce. Each new reject resets the timer so rapid
  // rejections coalesce into a single auto-fire rather than each
  // resetting a tight window. Fires only once 2+ rejects have
  // accumulated since the last AI turn — a single click-only reject
  // doesn't fire anything. The user can always click Send manually
  // if they want the AI to engage on a single signal.
  function scheduleAutoRefine() {
    if (autoRefineTimer.current) clearTimeout(autoRefineTimer.current)
    autoRefineTimer.current = setTimeout(() => {
      autoRefineTimer.current = null
      if (generatingRef.current) return
      if (unservedRejectsRef.current < 2) return
      void handleSuggest({ autoRefresh: true })
    }, 5000)
  }

  function bumpRejectSignal() {
    unservedRejectsRef.current += 1
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
      prev.map((c) =>
        c.id === id ? { ...c, decision: newDecision } : c,
      ),
    )

    // Surface decision changes in the chat log so the conversation
    // captures everything that shapes future suggestions, not just
    // typed refinements.
    if (newDecision === 'reject' && oldDecision !== 'reject') {
      appendSystemMessage(`✗ Rejected: ${target.suggestion.title}`)
      // Count this toward the reject-cluster threshold. A single
      // click-only reject doesn't auto-fire the AI on its own; we
      // only trigger once 2+ rejects accumulate (see scheduleAutoRefine).
      bumpRejectSignal()
    } else if (oldDecision === 'reject' && newDecision !== 'reject') {
      appendSystemMessage(`↩ Unrejected: ${target.suggestion.title}`)
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
        ? resolveRestoreTitle({
            slotItemId: fromSlotItemId,
            slotPlaceholders,
            candidatePriorSlotTitle: candidate.priorSlotTitle,
            // No taint check at commit-time move-source — we trust
            // the candidate's prior since the source slot's title
            // was the one we captured at original commit.
            fallbackForSlot: fallbackSlotTitle,
          })
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
    const newPriorSlotTitle = placeholderForSlot(slotItem)
    // Overwrite semantics: if a different committed candidate is
    // sitting in the target slot, evict it back to the candidate
    // pool (decision stays 'pending', commit state cleared) so the
    // user can re-pick it later. Match the AI's set_slot_contents
    // path so user-driven and AI-driven overwrites behave the same.
    // Title for the system message uses the candidate's suggestion
    // title when we know it, falling back to the slot's PCO songTitle
    // when the displaced song was placed via PCO directly.
    const evictedCandidate = findEvictionTarget(
      slotItem.id,
      candidates,
      candidate.id,
    )
    const evictedTitle =
      evictedCandidate?.suggestion.title ?? slotItem.songTitle ?? null
    const evictionRollback = evictedCandidate
      ? {
          id: evictedCandidate.id,
          committedAt: evictedCandidate.committedAt,
          assignedSlotItemId: evictedCandidate.assignedSlotItemId,
          priorSlotTitle: evictedCandidate.priorSlotTitle,
        }
      : null
    const rollbackSnapshot = {
      decision: candidate.decision,
      committedAt: candidate.committedAt,
      assignedSlotItemId: candidate.assignedSlotItemId,
      priorSlotTitle: candidate.priorSlotTitle,
    }
    // Optimistic flip. commitPending shields the new candidate from
    // the reconciliation effect until items refreshes (see CLAUDE.md
    // note on the batching pattern). The evicted candidate (if any)
    // is reset in the same setCandidates call so the UI never
    // momentarily shows two candidates committed to the same slot.
    setCandidates((prev) =>
      prev.map((c) => {
        if (c.id === candidate.id) {
          return {
            ...c,
            committedAt: Date.now(),
            assignedSlotItemId: slotItem.id,
            priorSlotTitle: newPriorSlotTitle,
            commitPending: true,
          }
        }
        if (evictedCandidate && c.id === evictedCandidate.id) {
          return {
            ...c,
            committedAt: null,
            assignedSlotItemId: null,
            priorSlotTitle: null,
          }
        }
        return c
      }),
    )
    const replaceSuffix = slotItem.songId
      ? ` (replacing "${evictedTitle ?? '(song)'}")`
      : ''
    if (source === 'ai') {
      appendSystemMessage(
        isMove
          ? `🤖 AI moved "${songTitle}" from song slot ${fromSlotIndex ?? '?'} to song slot ${slotIndex}${replaceSuffix}`
          : `🤖 AI committed "${songTitle}" to song slot ${slotIndex}${replaceSuffix}`,
      )
    } else {
      appendSystemMessage(
        isMove
          ? `↕ Moved "${songTitle}" → ${slotLabel}${replaceSuffix}`
          : `↗ Committed "${songTitle}" → ${slotLabel}${replaceSuffix}`,
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
        await refreshPlanState()
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
        prev.map((c) => {
          if (c.id === candidate.id) {
            return { ...c, ...rollbackSnapshot, commitPending: false }
          }
          if (evictionRollback && c.id === evictionRollback.id) {
            return {
              ...c,
              committedAt: evictionRollback.committedAt,
              assignedSlotItemId: evictionRollback.assignedSlotItemId,
              priorSlotTitle: evictionRollback.priorSlotTitle,
            }
          }
          return c
        }),
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
    // Restore-title resolution via the shared resolver — see
    // src/lib/planActions/helpers.ts for the priority order.
    const committedCandidate = candidates.find(
      (c) => c.assignedSlotItemId === slotItem.id && c.committedAt != null,
    )
    const knownSongTitlesLower = buildKnownSongTitles(candidates, items)
    const restoreTitle = resolveRestoreTitle({
      slotItemId: slotItem.id,
      slotPlaceholders,
      candidatePriorSlotTitle: committedCandidate?.priorSlotTitle,
      knownSongTitles: knownSongTitlesLower,
      fallbackForSlot: fallbackSlotTitle,
    })
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
        await refreshPlanState()
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
      // Trade the placeholders too — without this, the item that
      // moves to position N still carries the placeholder for its
      // OLD position, and a later clear restores the wrong title.
      // Optimistic local swap first; the callable persists it so
      // a fresh load from a different session sees the right map.
      setSlotPlaceholders((prev) => {
        const valA = prev[slotA.id]
        const valB = prev[slotB.id]
        if (valA === undefined && valB === undefined) return prev
        const next = { ...prev }
        if (valB !== undefined) next[slotA.id] = valB
        else delete next[slotA.id]
        if (valA !== undefined) next[slotB.id] = valA
        else delete next[slotB.id]
        return next
      })
      try {
        await swapSlotPlaceholdersCall({
          planId,
          itemIdA: slotA.id,
          itemIdB: slotB.id,
        })
      } catch (e) {
        // Persist failure isn't fatal — local state still reflects
        // the swap. Worst case, a fresh session load picks up the
        // pre-swap map and restores the "wrong" placeholder once.
        console.warn('[songpicker] swapSlotPlaceholders persist failed:', e)
      }
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

  // Thin wrappers binding the pure helpers to this component's closure
  // (items, slotPlaceholders). Both call into src/lib/planActions/helpers.
  // See that module for the docs and tests.
  function fallbackSlotTitle(itemId: string): string {
    return fallbackSlotTitleHelper(itemId, items)
  }
  function placeholderForSlot(slotItem: PlanItem): string | null {
    return placeholderForSlotHelper(slotItem, slotPlaceholders, fallbackSlotTitle)
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
  // Branches on source/target fill state per the user's mental model
  // — placeholders are tied to slot positions, songs move between
  // them. The asymmetric (one filled, one empty) cases route through
  // placeSongAction as a MOVE — placeholders never travel via
  // reorder, only the song does. The both-filled case is the only
  // genuine reorder; swapSlotsAction handles the placeholder swap so
  // a later clear restores the right placeholder for the new
  // position. Both-empty is a no-op (nothing to move).
  async function reorderSlotItem(draggedId: string, targetId: string) {
    if (draggedId === targetId) return
    const draggedSlot = (items ?? []).find((it) => it.id === draggedId)
    const targetSlot = (items ?? []).find((it) => it.id === targetId)
    if (!draggedSlot || !targetSlot) return

    const sourceFilled = !!draggedSlot.songId
    const targetFilled = !!targetSlot.songId

    if (sourceFilled && targetFilled) {
      // Both filled → real swap. Sequences trade; songs travel with
      // their items; placeholders ALSO trade (handled inside
      // swapSlotsAction) so the position binding survives.
      await swapSlotsAction({ slotA: draggedSlot, slotB: targetSlot })
      return
    }
    if (!sourceFilled && !targetFilled) {
      // Both empty → nothing to move. Reordering two empty
      // placeholders has no visible effect anyway.
      return
    }
    // Exactly one is filled. Move that song into the other slot,
    // letting the empty slot's placeholder stay where it is. The
    // "moving slot" is whichever currently has the song; the
    // "destination" is the other.
    const movingSlot = sourceFilled ? draggedSlot : targetSlot
    const destSlot = sourceFilled ? targetSlot : draggedSlot
    const committedCand = candidates.find(
      (c) =>
        c.assignedSlotItemId === movingSlot.id &&
        c.committedAt != null &&
        c.song,
    )
    if (committedCand) {
      await placeSongAction({ candidate: committedCand, slotItem: destSlot })
      return
    }
    if (!movingSlot.songId || !movingSlot.songTitle) {
      setGenerateError(
        `Can't move "${movingSlot.songTitle ?? movingSlot.title}" — missing song info on the source slot.`,
      )
      return
    }
    // The moving slot has no committed candidate in our state
    // (e.g., the song was linked via PCO directly before songpicker
    // started). No candidate prior to consult — the resolver falls
    // through persistedPlaceholder → "Song N".
    const sourceRestoreTitle = resolveRestoreTitle({
      slotItemId: movingSlot.id,
      slotPlaceholders,
      fallbackForSlot: fallbackSlotTitle,
    })
    const songTitle = movingSlot.songTitle
    const destLabel =
      destSlot.title?.trim() || fallbackSlotTitle(destSlot.id)
    try {
      await placeSongInSlot({
        serviceTypeId,
        planId,
        slotItemId: destSlot.id,
        songId: movingSlot.songId,
        songTitle,
        fromSlotItemId: movingSlot.id,
        fromSlotRestoreTitle: sourceRestoreTitle,
      })
      await refreshPlanState()
      appendSystemMessage(`↕ Moved "${songTitle}" → ${destLabel}`)
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

        <h2>
          {plan.title || plan.seriesTitle || '(no title)'}
          <a
            className="pco-link iconbtn iconbtn-sm iconbtn-pco"
            href={`https://services.planningcenteronline.com/plans/${plan.id}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in Planning Center"
            aria-label="Open in Planning Center"
          >
            <img src="/planning-center-icon.png" alt="" className="iconbtn-img" />
          </a>
        </h2>
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
              // Candidates can be dropped onto any song slot — empty
              // slots commit fresh, filled slots replace the existing
              // song (and return the displaced song to the candidate
              // pool as uncommitted).
              const isCommitTarget = dragKind === 'candidate' && isSong
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
                      if (candidate) {
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
                          className="ititle ititle-link icon-text"
                          href={`https://services.planningcenteronline.com/songs/${it.songId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open song in Planning Center"
                          // Anchors are natively draggable (for URL
                          // drops); turn that off so the parent <li>
                          // gets the dragstart instead.
                          draggable={false}
                        >
                          {displayTitle || '(song)'}
                          <Icon name="external-link" size={12} />
                        </a>
                        {isSong && (
                          <button
                            type="button"
                            className="clear-slot-btn"
                            onClick={() => void clearSlotAction({ slotItem: it })}
                            title="Remove this song from the slot and reopen it for new suggestions"
                            aria-label="Remove song from slot"
                          >
                            <Icon name="x" size={14} />
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="ititle">{it.title || '(no title)'}</div>
                    )}
                    {isSong && !filled && (
                      <span className="song-empty">Drop a song here</span>
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
                          onSaved={refreshPlanState}
                        />
                      )}
                      {displayTitle && (
                        <div className="lookup-row">
                          <SongLookupLinks query={displayTitle} size="sm" />
                        </div>
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
        return (
          <details
            className="rejected-pool"
            open={rejectedPoolOpen}
            onToggle={(e) => setRejectedPoolOpen(e.currentTarget.open)}
          >
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

        </div>

        <div className="plan-right">
      {candidates.length === 0 && (
        <EmptyState
          icon="sparkle"
          title="No suggestions yet"
          body={
            <>
              Tap <span className="empty-state-emph">Suggest songs</span> to
              get a fresh round from the AI.
            </>
          }
        />
      )}
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
            <span className="gradient-text">AI candidates</span>
            <span className="candidates-summary">({active.length})</span>
          </h3>
          <ul>
            {active.map((c, i) => {
              const matched = c.matchStatus === 'matched' && c.song
              const candidateDraggable = !!matched && !c.committedAt
              const candidateBeingDragged =
                dragKind === 'candidate' && dragSourceId === c.id
              // Stagger entrance — CSS animation reads this delay so
              // newly-arrived cards cascade in instead of all popping
              // at once. Cap at 12 so a big batch doesn't drag on.
              const enterDelay = `${Math.min(i, 12) * 50}ms`
              return (
                <li
                  key={c.id}
                  className={`candidate match-${c.matchStatus} decision-${c.decision}${
                    candidateDraggable ? ' is-draggable' : ''
                  }${candidateBeingDragged ? ' is-dragging' : ''}`}
                  style={{ animationDelay: enterDelay }}
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
                        className="ctitle-link icon-text"
                        href={`https://services.planningcenteronline.com/songs/${c.song!.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open in Planning Center"
                        draggable={false}
                      >
                        {c.suggestion.title}
                        <Icon name="external-link" size={12} />
                      </a>
                    ) : (
                      c.suggestion.title
                    )}
                    {c.suggestion.author && (
                      <span className="author"> — {c.suggestion.author}</span>
                    )}
                  </div>
                  <div className="cstatus">
                    {c.suggestion.slots?.map((s, si) => (
                      <span key={`slot-${si}`} className="slot-tag">
                        {s}
                      </span>
                    ))}
                    {c.matchStatus === 'checking' && (
                      <span className="chip chip-checking">
                        checking library…
                      </span>
                    )}
                    {matched && (
                      <>
                        <span className="chip chip-matched">
                          <Icon name="check" size={12} />
                          in library
                        </span>
                        {c.song!.lastScheduledAt ? (
                          (() => {
                            const recent = playedWithinDays(
                              c.song!.lastScheduledAt,
                              28,
                            )
                            return (
                              <span
                                className={`chip chip-time${recent ? ' chip-recent' : ''}`}
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
                              </span>
                            )
                          })()
                        ) : (
                          <span className="chip chip-time chip-never">
                            never played
                          </span>
                        )}
                        {c.song!.ccliNumber && (
                          <span
                            className="chip chip-ccli"
                            title="CCLI number"
                          >
                            CCLI {c.song!.ccliNumber}
                          </span>
                        )}
                      </>
                    )}
                    {c.matchStatus === 'unmatched' && (
                      <span className="chip chip-unmatched">
                        <Icon name="alert-triangle" size={12} />
                        not in library
                      </span>
                    )}
                    {c.matchStatus === 'error' && (
                      <span
                        className="chip chip-error"
                        title={c.error}
                      >
                        lookup failed
                      </span>
                    )}
                  </div>
                  {c.suggestion.chorusSnippet && (
                    <div className="chorus-snippet">
                      <span className="snippet-quote" aria-hidden>“</span>
                      {c.suggestion.chorusSnippet}
                      <span className="snippet-quote" aria-hidden>”</span>
                    </div>
                  )}
                  <div className="decision-row">
                    {/* Outbound listen/lookup buttons — square icon-only,
                        brand-colored on hover. Provider list lives in
                        SongLookupLinks so this row stays in sync with
                        the service-order filled-slot row. */}
                    <div className="listen-actions">
                      <SongLookupLinks query={c.suggestion.title} />
                    </div>

                    <div className="decision-actions">
                      <button
                        type="button"
                        className={`decision-btn decision-reject icon-text${c.decision === 'reject' ? ' on' : ''}`}
                        onClick={() => setDecision(c.id, 'reject')}
                        disabled={!!c.committedAt}
                        title={
                          c.decision === 'reject'
                            ? 'Click again to undo'
                            : 'Reject this song'
                        }
                      >
                        <Icon name="x" size={13} />
                        Reject
                      </button>

                      {matched && c.committedAt && (
                        // Service order on the left is the source of
                        // truth for WHICH slot. Showing a slot label
                        // here was nonsensical anyway — PCO overwrites
                        // the slot's title with the song name on commit.
                        <span className="committed-badge icon-text">
                          <Icon name="check" size={13} />
                          Committed
                        </span>
                      )}

                      {matched && !c.committedAt && (() => {
                        // Replaces the old <select> with a button +
                        // popover. The button is the primary "action"
                        // affordance on each card and gets accent
                        // styling; the popover lists the same options
                        // the select used to.
                        const avail = emptySongSlots
                        const isOpen = openCommitMenuId === c.id
                        const disabled = avail.length === 0
                        return (
                          <div
                            className={`commit-menu${isOpen ? ' open' : ''}`}
                          >
                            <button
                              type="button"
                              className="commit-btn icon-text"
                              disabled={disabled}
                              onClick={() =>
                                setOpenCommitMenuId(isOpen ? null : c.id)
                              }
                              title={
                                disabled
                                  ? 'No empty song slots available'
                                  : 'Commit to slot'
                              }
                              aria-haspopup="menu"
                              aria-expanded={isOpen}
                            >
                              {disabled ? 'No open slots' : 'Commit to slot'}
                              {!disabled && (
                                <Icon name="chevron-down" size={13} />
                              )}
                            </button>
                            {isOpen && !disabled && (
                              <div
                                className="commit-menu-pop"
                                role="menu"
                              >
                                {avail.map((s) => (
                                  <button
                                    key={s.id}
                                    type="button"
                                    role="menuitem"
                                    className="commit-menu-item"
                                    onClick={() => {
                                      setOpenCommitMenuId(null)
                                      void placeSongAction({
                                        candidate: c,
                                        slotItem: s,
                                      })
                                    }}
                                  >
                                    {s.title}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
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

