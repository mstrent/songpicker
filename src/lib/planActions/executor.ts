import type { PlanItem } from '../api'
import { synthesizeMessages, type MessageSource } from './messages'
import type { Plan } from './resolver'

// Side-effecting layer that takes a resolved Plan and applies it:
// optimistic items state, PCO calls in two phases (clears before
// commits for swap correctness), state refresh, rollback on
// failure, chat messages.
//
// Phase 6 dropped all candidate-state mutation. The candidate pool
// is upstream of slot-state — its rendering of "is this candidate
// committed?" is derived from the items state we update here. So
// the executor only touches items + PCO, never candidates.

/** PCO write callables. Production wires these to the typed
 *  httpsCallable wrappers in src/lib/api. Tests pass mocks. */
export interface PcoCallables {
  placeSongInSlot: (params: {
    serviceTypeId: string
    planId: string
    slotItemId: string
    songId: string
    songTitle?: string
  }) => Promise<unknown>
  clearSongFromSlot: (params: {
    serviceTypeId: string
    planId: string
    slotItemId: string
    restoreTitle?: string
  }) => Promise<unknown>
}

export interface ExecutorDeps {
  serviceTypeId: string
  planId: string
  pco: PcoCallables
  /** Optimistic items mutator. Production wires to setItems
   *  (React state); tests pass a capture. The executor calls this
   *  with a functional updater. */
  setItems: (
    update: (prev: readonly PlanItem[] | null) => PlanItem[] | null,
  ) => void
  appendSystemMessage: (msg: string) => void
  /** Re-fetch items + slotPlaceholders + apply to React state.
   *  Called once at the end of the executor unless deferRefresh
   *  is set. */
  refreshPlanState: () => Promise<void>
}

export interface ExecutorOptions {
  source?: MessageSource
  /** When true, the executor SKIPS its post-write refresh — caller
   *  is responsible for calling refreshPlanState. Used by the AI
   *  stream which fires multiple actions and refreshes once at the
   *  end of the stream. */
  deferRefresh?: boolean
}

export interface ExecutorResult {
  pcoWritesFired: boolean
  messages: string[]
}

interface PlannedClear {
  slotItem: PlanItem
  restoreTitle: string
}

interface PlannedCommit {
  songId: string
  songTitle: string
}

export async function executePlan(
  plan: Plan,
  deps: ExecutorDeps,
  options: ExecutorOptions = {},
): Promise<ExecutorResult> {
  const source = options.source ?? 'user'
  const messages: string[] = []

  for (const w of plan.warnings) {
    deps.appendSystemMessage(`⚠ ${w}`)
  }

  if (plan.resolved.length === 0) {
    return { pcoWritesFired: false, messages }
  }

  const plannedClears = new Map<string, PlannedClear>()
  const plannedCommits = new Map<string, PlannedCommit>()

  // Snapshot current items so we can roll back on failure. Captured
  // BEFORE any optimistic mutations land.
  let preOptimisticItems: PlanItem[] | null = null
  deps.setItems((prev) => {
    preOptimisticItems = prev ? prev.map((it) => ({ ...it })) : null
    return prev ? prev.slice() : null
  })

  // Apply optimistic items state for every resolved entry — slots
  // immediately show their post-PCO content so the UI doesn't lag
  // a sub-second behind the user's drop.
  deps.setItems((prev) => {
    if (!prev) return prev
    const next = prev.map((it) => ({ ...it }))
    for (const r of plan.resolved) {
      const idx = next.findIndex((it) => it.id === r.slotItemId)
      if (idx === -1) continue
      if (r.kind === 'clear') {
        next[idx] = {
          ...next[idx],
          songId: null,
          songTitle: null,
          songAuthor: null,
          songCcli: null,
          arrangementId: null,
          keyId: null,
          keyName: null,
          title: r.restoreTitle,
        }
      } else {
        next[idx] = {
          ...next[idx],
          songId: r.songId,
          songTitle: r.songTitle,
          title: r.songTitle,
        }
        // For moves, the source slot also empties optimistically.
        if (r.fromSlotItemId && r.fromSlotRestoreTitle) {
          const sIdx = next.findIndex((it) => it.id === r.fromSlotItemId)
          if (sIdx !== -1) {
            next[sIdx] = {
              ...next[sIdx],
              songId: null,
              songTitle: null,
              songAuthor: null,
              songCcli: null,
              arrangementId: null,
              keyId: null,
              keyName: null,
              title: r.fromSlotRestoreTitle,
            }
          }
        }
      }
    }
    return next
  })

  // Build PCO op plan.
  for (const r of plan.resolved) {
    if (r.kind === 'clear') {
      plannedClears.set(r.slotItemId, {
        slotItem: r.slotItem,
        restoreTitle: r.restoreTitle,
      })
      continue
    }
    if (r.isMove && r.fromSlotItem && r.fromSlotRestoreTitle) {
      plannedClears.set(r.fromSlotItem.id, {
        slotItem: r.fromSlotItem,
        restoreTitle: r.fromSlotRestoreTitle,
      })
    }
    plannedCommits.set(r.slotItemId, {
      songId: r.songId,
      songTitle: r.songTitle,
    })
  }

  const lines = synthesizeMessages(plan, source)
  for (const line of lines) {
    deps.appendSystemMessage(line)
    messages.push(line)
  }

  // Drop clears for slots that are also commit targets — the
  // commit's PATCH overwrites the cleared state anyway.
  for (const slotId of plannedCommits.keys()) {
    plannedClears.delete(slotId)
  }

  let anyCommitFailed = false

  // Phase 1: clears
  for (const [slotItemId, { restoreTitle }] of plannedClears) {
    try {
      await deps.pco.clearSongFromSlot({
        serviceTypeId: deps.serviceTypeId,
        planId: deps.planId,
        slotItemId,
        restoreTitle,
      })
    } catch (e) {
      anyCommitFailed = true
      deps.appendSystemMessage(
        `⚠ Clear failed for a slot — ${(e as Error).message}`,
      )
    }
  }

  // Phase 2: commits.
  for (const [slotItemId, { songId, songTitle }] of plannedCommits) {
    try {
      await deps.pco.placeSongInSlot({
        serviceTypeId: deps.serviceTypeId,
        planId: deps.planId,
        slotItemId,
        songId,
        songTitle,
      })
    } catch (e) {
      anyCommitFailed = true
      const verb = source === 'ai' ? 'AI commit' : 'Commit'
      deps.appendSystemMessage(
        `⚠ ${verb} failed for "${songTitle}" — ${(e as Error).message}`,
      )
    }
  }

  const pcoWritesFired = plannedClears.size > 0 || plannedCommits.size > 0

  // Rollback optimistic items if any commit failed AND we're not
  // about to refresh (refresh would correct the state from PCO).
  // If refresh is deferred, restore the pre-optimistic snapshot so
  // the UI doesn't show a partial / wrong state.
  if (anyCommitFailed && options.deferRefresh) {
    const snapshot = preOptimisticItems
    deps.setItems(() => snapshot)
  }

  if (pcoWritesFired && !options.deferRefresh) {
    try {
      await deps.refreshPlanState()
    } catch {
      // Refresh is best-effort.
    }
  }

  return { pcoWritesFired, messages }
}
