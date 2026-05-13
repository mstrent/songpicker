import type { CandidateState } from './helpers'

// Unified decision-change layer. Both UI button clicks and AI
// remove_candidates / unreject_candidates tool actions flow
// through applyDecisionChange so the rules (eligibility,
// committed-protection, message format) live in one place.

export type DecisionSource = 'user' | 'ai'

export interface DecisionChange {
  ids: readonly string[]
  /** 'reject' marks candidates as rejected (the only non-pending
   *  decision today). 'pending' is the unreject — restore them to
   *  the active pool. */
  decision: 'reject' | 'pending'
}

export interface ApplyDecisionDeps {
  /** Snapshot of the candidate pool as the caller sees it RIGHT
   *  NOW. Used to compute eligibility (committed-skip,
   *  already-rejected skip, etc.) synchronously — the React state
   *  setter below may run its updater asynchronously, so we can't
   *  rely on it to determine which ids actually changed. */
  candidates: readonly CandidateState[]
  /** React-shaped state mutator. */
  setCandidates: (
    update: (prev: readonly CandidateState[]) => CandidateState[],
  ) => void
  appendSystemMessage: (msg: string) => void
  /** Set of song.id values currently linked in the PCO plan. Used to
   *  enforce the "can't reject committed" rule — a candidate whose
   *  matched library song is currently in the plan is treated as
   *  committed. Phase 6 made this derived (from items) rather than
   *  stored on the candidate. The caller computes
   *  `new Set(items.filter(it => it.songId).map(it => it.songId))`. */
  committedSongIds: ReadonlySet<string>
  /** Called once after a non-empty reject succeeds, so the SPA can
   *  open the rejected pool and bump the auto-refine counter. UI
   *  passes a real handler; AI passes a noop. */
  onRejectsLanded?: (count: number) => void
}

export interface ApplyDecisionResult {
  changedIds: string[]
}

/** Apply a decision change to a set of candidates.
 *
 *  Reject path skips:
 *    - candidates whose matched song is currently in the plan
 *      (rejecting a committed song is almost always a "replace it"
 *      misinterpretation — see CLAUDE.md). Committed status is
 *      derived from items.songId, not stored on candidates.
 *    - already-rejected candidates
 *
 *  Unreject path skips:
 *    - non-rejected candidates */
export function applyDecisionChange(
  change: DecisionChange,
  source: DecisionSource,
  deps: ApplyDecisionDeps,
): ApplyDecisionResult {
  // Compute eligibility synchronously from the supplied snapshot.
  // We don't rely on setCandidates' functional updater to decide
  // changedIds because React 19 may defer it; reading the snapshot
  // directly gives us a deterministic result we can act on (emit
  // messages, bump signals) before this function returns.
  const changedIds: string[] = []
  const titleById = new Map<string, string>()
  for (const c of deps.candidates) {
    if (!change.ids.includes(c.id)) continue
    titleById.set(c.id, c.suggestion.title)
    if (change.decision === 'reject') {
      if (c.song?.id && deps.committedSongIds.has(c.song.id)) continue
      if (c.decision === 'reject') continue
      changedIds.push(c.id)
    } else {
      if (c.decision !== 'reject') continue
      changedIds.push(c.id)
    }
  }

  if (changedIds.length === 0) return { changedIds }

  // Apply the flip via setCandidates. The functional updater is
  // pure (idempotent); whether React runs it once or batches it is
  // immaterial because the outcome depends only on the prev arg
  // and the precomputed changedIds set.
  const flipTo = change.decision === 'reject' ? 'reject' : 'pending'
  const flipSet = new Set(changedIds)
  deps.setCandidates((prev) =>
    prev.map((c) => (flipSet.has(c.id) ? { ...c, decision: flipTo } : c)),
  )

  const titles = changedIds
    .map((id) => titleById.get(id) ?? `(unknown ${id})`)
    .join(', ')
  if (change.decision === 'reject') {
    if (source === 'ai') {
      deps.appendSystemMessage(`🤖 AI rejected ${titles}`)
    } else {
      for (const id of changedIds) {
        const t = titleById.get(id) ?? `(unknown ${id})`
        deps.appendSystemMessage(`✗ Rejected: ${t}`)
      }
    }
    deps.onRejectsLanded?.(changedIds.length)
  } else {
    if (source === 'ai') {
      deps.appendSystemMessage(`🤖 AI restored ${titles} to the candidate pool`)
    } else {
      for (const id of changedIds) {
        const t = titleById.get(id) ?? `(unknown ${id})`
        deps.appendSystemMessage(`↩ Unrejected: ${t}`)
      }
    }
  }
  return { changedIds }
}
