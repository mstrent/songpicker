import React, { useEffect, useRef, useState } from 'react'
import {
  clearSlot,
  commitSlot,
  loadSession,
  reorderItems as reorderItemsCall,
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
  const [minCount, setMinCount] = useState(3)
  const [maxCount, setMaxCount] = useState(8)
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
  // Mirror candidates + maxCount in refs so the debounced replacement
  // timer reads the latest values when it fires 600ms later (the
  // closure captured at scheduleReplacement time would otherwise be
  // stale).
  const candidatesRef = useRef<CandidateMatch[]>([])
  const maxCountRef = useRef(maxCount)

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
          // Floor at the number of empty slots so the AI always returns
          // enough to populate the order; cap min at 3 so very short
          // services still get some variety.
          setMinCount(Math.max(songSlotCount, 3))
          setMaxCount(Math.max(songSlotCount * 2, 8))
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

  // Keep the latest candidates / maxCount available to the debounced
  // auto-replacement timer (which fires 600ms after the last reject —
  // the candidates closure it would otherwise capture is stale by
  // then).
  useEffect(() => {
    candidatesRef.current = candidates
  }, [candidates])
  useEffect(() => {
    maxCountRef.current = maxCount
  }, [maxCount])

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

  // Core suggestion fetcher used by both the user-driven Suggest button and
  // the silent auto-replacement after rejections. The `addToChat` flag
  // splits the two behaviours: user-driven calls record a chat turn and
  // surface the spinner / errors; auto-replacements run quietly in the
  // background.
  async function fetchSuggestions(opts: {
    minCount: number
    maxCount: number
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
        minCount: opts.minCount,
        maxCount: opts.maxCount,
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

      // The model can still over-deliver past the requested max — defend
      // against that on the client and slice down to the user's chosen
      // upper bound so the candidate list doesn't blow out.
      const accepted = res.data.suggestions.slice(0, opts.maxCount)

      const now = Date.now()
      const newOnes: CandidateMatch[] = accepted.map((s) => ({
        id: newCandidateId(),
        suggestion: s,
        matchStatus: 'checking',
        decision: 'pending',
        addedAt: now,
        assignedSlotItemId: null,
        committedAt: null,
        priorSlotTitle: null,
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
      minCount,
      maxCount,
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
      // After refinement turns the list can grow past the user's
      // requested max. In that case rejecting shouldn't keep refilling
      // the list — they're trying to trim down. Skip replacement
      // whenever the post-rejection active count is already at or
      // above maxCount, and only ask for enough to bring us back up to
      // max when there IS room.
      const activeCount = candidatesRef.current.filter(
        (c) => c.decision !== 'reject',
      ).length
      const maxC = maxCountRef.current
      if (activeCount >= maxC) {
        appendSystemMessage(
          `↻ Skipped auto-replacement — ${activeCount} song${activeCount === 1 ? '' : 's'} still on the list, at or above the requested max of ${maxC}`,
        )
        return
      }
      const fillCount = Math.min(n, maxC - activeCount)
      void fetchSuggestions({
        // Auto-replacement pins min=max so the model returns exactly
        // the number of replacement songs we asked for — capped at
        // the room remaining under maxCount.
        minCount: fillCount,
        maxCount: fillCount,
        userMessage: `(auto-replacement for ${fillCount} rejected song${fillCount === 1 ? '' : 's'})`,
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
                        <div className="meta-chips">
                          {filled && it.songId && (
                            <ArrangementKeyEditor
                              serviceTypeId={serviceTypeId}
                              planId={planId}
                              item={it}
                              onSaved={async () => {
                                invalidatePlanContext(serviceTypeId, planId)
                                const fresh = await loadPlanContext(
                                  serviceTypeId,
                                  planId,
                                )
                                setItems(fresh.items)
                              }}
                            />
                          )}
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
                      draggable={false}
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
            <span>Min</span>
            <input
              type="number"
              min={1}
              max={50}
              value={minCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                if (!Number.isNaN(v)) {
                  setMinCount(Math.max(1, v))
                  if (v > maxCount) setMaxCount(v)
                }
              }}
              title="Minimum number of suggestions the AI should return"
            />
          </label>
          <label className="inline">
            <span>Max</span>
            <input
              type="number"
              min={1}
              max={50}
              value={maxCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                if (!Number.isNaN(v)) {
                  setMaxCount(Math.max(1, v))
                  if (v < minCount) setMinCount(v)
                }
              }}
              title="Maximum number of suggestions the AI should return"
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
