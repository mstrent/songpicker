import { useEffect, useRef, useState } from 'react'
import {
  clearSongFromSlot,
  placeSongInSlot,
  refreshSlotState as refreshSlotStateCallable,
  savePlanNotes,
  savePlanTheme,
  type Plan,
  type PlanItem,
  type PlanNote,
} from './api'
import {
  loadPlanContext,
  patchCachedNotes,
  patchCachedSlotState,
  patchCachedTheme,
} from './cache'
import {
  compileSlotToSlot,
} from './planActions/compile'
import {
  executePlan,
  type ExecutorDeps,
  type ExecutorResult,
} from './planActions/executor'
import {
  fallbackSlotTitle as fallbackSlotTitleHelper,
} from './planActions/helpers'
import {
  resolvePlan,
  type Assignment,
} from './planActions/resolver'
import type { MessageSource } from './planActions/messages'

// Plan-side state + slot operations. PCO is the source of truth for
// plan data; this hook mirrors PCO's view (items + slot
// placeholders) and exposes slot-state operations on top. The
// candidate pool is a separate concept — see useCandidatePool —
// that depends on this hook for items state but never the other
// way around. See CLAUDE.md (Architecture philosophy) and
// docs/unification-plan.md.

function formatNotesSource(notes: readonly PlanNote[]): string {
  if (!notes || notes.length === 0) return ''
  return notes
    .filter((n) => n.content && n.content.trim())
    .map((n) =>
      n.category ? `[${n.category}] ${n.content.trim()}` : n.content.trim(),
    )
    .join('\n\n')
}

export interface PerformIntentOptions {
  source?: MessageSource
  /** When true, the executor SKIPS its post-write refresh — caller
   *  is responsible for refreshing later (used by AI flow which
   *  batches writes across the stream). */
  deferRefresh?: boolean
  /** Forwarded to the resolver — when true, the assignments are
   *  rejected with a single warning. */
  autoRefresh?: boolean
}

export interface PlanDataApi {
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
  // Setters intended for UI
  setTheme: (s: string) => void
  setNotesText: (s: string) => void
  resetTheme: () => void
  resetNotes: () => void
  // Slot operations
  /** Apply one or more slot-state assignments. Returns when the
   *  PCO calls + post-refresh land (or immediately if deferRefresh
   *  is set). Both UI flows and the AI's set_slot_contents handler
   *  call this. */
  performIntent: (
    assignments: readonly Assignment[],
    options?: PerformIntentOptions,
  ) => Promise<ExecutorResult>
  /** DnD slot-onto-slot orchestration — compiles to assignments
   *  via compileSlotToSlot and forwards to performIntent. */
  reorderSlotItem: (draggedId: string, targetId: string) => Promise<void>
  /** Re-fetch items + slotPlaceholders from PCO and apply. */
  refreshPlanState: () => Promise<void>
  /** Position-based "Song N" fallback bound to current items. */
  fallbackSlotTitle: (itemId: string) => string
  /** Sets the items state directly — exposed for the executor
   *  optimistic update. Outside callers shouldn't use this; the
   *  hook composes it into performIntent. */
  setItems: (
    update: (prev: readonly PlanItem[] | null) => PlanItem[] | null,
  ) => void
  /** Append a chat-log line — exposed because slot operations
   *  emit them through the executor's deps. The candidate pool
   *  owns the messages array and provides a real implementation;
   *  PlanDetail wires planData with candidatePool.appendSystemMessage. */
  setAppendSystemMessage: (fn: (msg: string) => void) => void
  /** Same — the slot-state error channel needs to surface to the
   *  plan-level error display. The candidate pool exposes its own
   *  error setter; PlanDetail wires this. */
  setGenerateErrorHandler: (fn: (msg: string | null) => void) => void
}

export function usePlanData(
  serviceTypeId: string,
  planId: string,
): PlanDataApi {
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

  const themeInitialized = useRef(false)
  const notesInitialized = useRef(false)
  const userTouchedTheme = useRef(false)
  const userTouchedNotes = useRef(false)

  // Wired by PlanDetail to point at useCandidatePool's
  // appendSystemMessage / setGenerateError. We keep refs so changing
  // them doesn't trigger executor-deps recreation per render.
  const appendSystemMessageRef = useRef<(msg: string) => void>(() => {})
  const setGenerateErrorRef = useRef<(msg: string | null) => void>(() => {})

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

  // Plan load (re-runs on plan switch).
  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    setPlan(null)
    setNotes(null)
    setItems(null)
    setSlotPlaceholders({})
    setThemeSource('')
    setNotesSource('')
    themeInitialized.current = false
    notesInitialized.current = false
    userTouchedTheme.current = false
    userTouchedNotes.current = false

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
    // Lean refresh — fetches just items + slotPlaceholders (the
    // only fields that change on a slot write). Saves the
    // plan/notes/userTheme/userNotes round-trip vs. the original
    // loadPlanContext path. The session cache gets patched in
    // place so future plan-load doesn't re-fetch the full thing.
    const sr = await refreshSlotStateCallable({ serviceTypeId, planId })
    const { items: freshItems, slotPlaceholders: freshPlaceholders } = sr.data
    setItems(freshItems)
    setSlotPlaceholders(freshPlaceholders)
    patchCachedSlotState(serviceTypeId, planId, freshItems, freshPlaceholders)
  }

  function fallbackSlotTitle(itemId: string): string {
    return fallbackSlotTitleHelper(itemId, items)
  }

  function executorDeps(): ExecutorDeps {
    return {
      serviceTypeId,
      planId,
      pco: { placeSongInSlot, clearSongFromSlot },
      setItems,
      appendSystemMessage: (msg) => appendSystemMessageRef.current(msg),
      refreshPlanState,
    }
  }

  async function performIntent(
    assignments: readonly Assignment[],
    options: PerformIntentOptions = {},
  ): Promise<ExecutorResult> {
    if (assignments.length === 0) {
      return { pcoWritesFired: false, messages: [] }
    }
    const plan = resolvePlan(
      assignments as Assignment[],
      { items: items ?? [], slotPlaceholders },
      { autoRefresh: options.autoRefresh },
    )
    return executePlan(plan, executorDeps(), {
      source: options.source ?? 'user',
      deferRefresh: options.deferRefresh,
    })
  }

  async function reorderSlotItem(
    draggedId: string,
    targetId: string,
  ): Promise<void> {
    if (draggedId === targetId) return
    const draggedSlot = (items ?? []).find((it) => it.id === draggedId)
    const targetSlot = (items ?? []).find((it) => it.id === targetId)
    if (!draggedSlot || !targetSlot) return
    const assignments = compileSlotToSlot(
      draggedSlot,
      targetSlot,
      items ?? [],
    )
    await performIntent(assignments)
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
    setTheme,
    setNotesText,
    resetTheme,
    resetNotes,
    performIntent,
    reorderSlotItem,
    refreshPlanState,
    fallbackSlotTitle,
    setItems,
    setAppendSystemMessage: (fn) => {
      appendSystemMessageRef.current = fn
    },
    setGenerateErrorHandler: (fn) => {
      setGenerateErrorRef.current = fn
    },
  }
}
