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
  const changedIds: string[] = []
  const titleById = new Map<string, string>()

  deps.setCandidates((prev) => {
    return prev.map((c) => {
      if (!change.ids.includes(c.id)) return c
      titleById.set(c.id, c.suggestion.title)
      if (change.decision === 'reject') {
        const songId = c.song?.id
        if (songId && deps.committedSongIds.has(songId)) return c
        if (c.decision === 'reject') return c
        changedIds.push(c.id)
        return { ...c, decision: 'reject' }
      }
      // unreject
      if (c.decision !== 'reject') return c
      changedIds.push(c.id)
      return { ...c, decision: 'pending' }
    })
  })

  if (changedIds.length === 0) return { changedIds }

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
