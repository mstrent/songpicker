import type { PlanItem } from '../api'
import type { CandidateState } from './helpers'
import { synthesizeMessages, type MessageSource } from './messages'
import type { Plan, ResolvedCommit, ResolvedEntry } from './resolver'

// Side-effecting layer that takes a resolved Plan and applies it:
// optimistic state, PCO calls in two phases (clears before commits
// for swap correctness), state refresh, rollback on failure, chat
// messages. The pure planning lives in resolver.ts; this module is
// where the I/O happens. Tests mock `deps` to verify behavior
// without touching React or PCO.

/** Slot/song state mutation contract. Designed to be implementable
 *  by either React's setState (production) or a plain assignment
 *  (tests). */
export interface CandidateUpdater {
  /** Apply a functional update to candidate state. */
  setCandidates: (
    update: (prev: readonly CandidateState[]) => CandidateState[],
  ) => void
}

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

export interface ExecutorDeps extends CandidateUpdater {
  serviceTypeId: string
  planId: string
  pco: PcoCallables
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
  /** True iff at least one PCO write actually fired. Callers use
   *  this to decide whether to refresh in deferRefresh mode. */
  pcoWritesFired: boolean
  /** Chat messages that were emitted (also passed through
   *  appendSystemMessage). Returned for testability. */
  messages: string[]
}

interface RollbackForCommit {
  id: string
  decision: 'pending' | 'reject'
  committedAt: number | null
  assignedSlotItemId: string | null
  priorSlotTitle: string | null
}

interface RollbackForEvicted {
  id: string
  committedAt: number | null
  assignedSlotItemId: string | null
  priorSlotTitle: string | null
}

interface PlannedClear {
  slotItem: PlanItem
  restoreTitle: string
}

interface PlannedCommit {
  candidateId: string
  songId: string
  songTitle: string
  rollback: () => void
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
  const now = Date.now()

  // Apply optimistic state for every resolved entry. Each commit
  // captures rollback snapshots from CURRENT state (not pre-turn)
  // so a failure restores exactly what we just displaced.
  for (const r of plan.resolved) {
    if (r.kind === 'clear') {
      applyClearOptimistic(r, deps)
      plannedClears.set(r.slotItemId, {
        slotItem: r.slotItem,
        restoreTitle: r.restoreTitle,
      })
      continue
    }
    const { rollbackForCandidate, rollbackForEvicted } = applyCommitOptimistic(
      r,
      deps,
      now,
    )
    if (r.isMove && r.fromSlotItem && r.fromSlotRestoreTitle) {
      plannedClears.set(r.fromSlotItem.id, {
        slotItem: r.fromSlotItem,
        restoreTitle: r.fromSlotRestoreTitle,
      })
    }
    plannedCommits.set(r.slotItemId, {
      candidateId: r.candidate.id,
      songId: r.songId,
      songTitle: r.songTitle,
      rollback: () => rollbackCommit(rollbackForCandidate, rollbackForEvicted, deps),
    })
  }

  // Emit chat messages via the shared synthesizer.
  const lines = synthesizeMessages(plan, source)
  for (const line of lines) {
    deps.appendSystemMessage(line)
    messages.push(line)
  }

  // Drop clears for slots that are also commit targets — the commit's
  // PATCH overwrites the cleared state anyway, so a separate clear is
  // wasted PCO traffic.
  for (const slotId of plannedCommits.keys()) {
    plannedClears.delete(slotId)
  }

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
      deps.appendSystemMessage(
        `⚠ Clear failed for a slot — ${(e as Error).message}`,
      )
    }
  }

  // Phase 2: commits. fromSlotItemId is omitted because phase 1 has
  // already cleared whatever sources needed clearing.
  for (const [slotItemId, { songId, songTitle, rollback }] of plannedCommits) {
    try {
      await deps.pco.placeSongInSlot({
        serviceTypeId: deps.serviceTypeId,
        planId: deps.planId,
        slotItemId,
        songId,
        songTitle,
      })
    } catch (e) {
      rollback()
      const verb = source === 'ai' ? 'AI commit' : 'Commit'
      deps.appendSystemMessage(
        `⚠ ${verb} failed for "${songTitle}" — ${(e as Error).message}`,
      )
    }
  }

  const pcoWritesFired = plannedClears.size > 0 || plannedCommits.size > 0

  // Refresh state — single PCO read picks up commits, clears, and
  // title restorations. Skipped when deferRefresh is set; the AI
  // stream uses that to refresh once after the whole turn rather
  // than per-action.
  if (pcoWritesFired && !options.deferRefresh) {
    try {
      await deps.refreshPlanState()
      // Clear commitPending on whichever candidates we marked it on.
      // We do it after refresh so the items+candidates reconciliation
      // sees both updates together (per CLAUDE.md note).
      deps.setCandidates((prev) =>
        prev.map((c) => {
          const hasPending =
            (c as unknown as { commitPending?: boolean }).commitPending === true
          return hasPending
            ? ({ ...c, commitPending: false } as CandidateState)
            : c
        }),
      )
    } catch {
      // Refresh is best-effort. Leave commitPending set — better
      // than flickering optimistic state away.
    }
  }

  return { pcoWritesFired, messages }
}

function applyClearOptimistic(
  r: Extract<ResolvedEntry, { kind: 'clear' }>,
  deps: CandidateUpdater,
): void {
  deps.setCandidates((prev) =>
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
}

function applyCommitOptimistic(
  r: ResolvedCommit,
  deps: CandidateUpdater,
  now: number,
): {
  rollbackForCandidate: RollbackForCommit | null
  rollbackForEvicted: RollbackForEvicted | null
} {
  let rollbackForCandidate: RollbackForCommit | null = null
  let rollbackForEvicted: RollbackForEvicted | null = null
  deps.setCandidates((prev) => {
    const me = prev.find((c) => c.id === r.candidate.id)
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
        rollbackForEvicted = {
          id: evictedNow.id,
          committedAt: evictedNow.committedAt,
          assignedSlotItemId: evictedNow.assignedSlotItemId,
          priorSlotTitle: evictedNow.priorSlotTitle,
        }
      }
    }
    return prev.map((c) => {
      if (c.id === r.candidate.id) {
        return {
          ...c,
          committedAt: now,
          assignedSlotItemId: r.slotItemId,
          priorSlotTitle: r.newPriorSlotTitle,
          // commitPending shields the candidate from the
          // reconciliation effect until items refreshes — see
          // CLAUDE.md note on the batching pattern. The cast is
          // safe because the production CandidateMatch type
          // includes commitPending; CandidateState omits it for
          // testability of the helpers.
          ...({ commitPending: true } as Partial<CandidateState>),
        }
      }
      if (
        c.assignedSlotItemId === r.slotItemId &&
        c.committedAt != null &&
        c.id !== r.candidate.id
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
  return { rollbackForCandidate, rollbackForEvicted }
}

function rollbackCommit(
  forCandidate: RollbackForCommit | null,
  forEvicted: RollbackForEvicted | null,
  deps: CandidateUpdater,
): void {
  deps.setCandidates((prev) =>
    prev.map((c) => {
      if (forCandidate && c.id === forCandidate.id) {
        return {
          ...c,
          decision: forCandidate.decision,
          committedAt: forCandidate.committedAt,
          assignedSlotItemId: forCandidate.assignedSlotItemId,
          priorSlotTitle: forCandidate.priorSlotTitle,
          ...({ commitPending: false } as Partial<CandidateState>),
        }
      }
      if (forEvicted && c.id === forEvicted.id) {
        return {
          ...c,
          committedAt: forEvicted.committedAt,
          assignedSlotItemId: forEvicted.assignedSlotItemId,
          priorSlotTitle: forEvicted.priorSlotTitle,
        }
      }
      return c
    }),
  )
}
