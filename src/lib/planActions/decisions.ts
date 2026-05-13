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
  /** Called once after a non-empty reject succeeds, so the SPA can
   *  open the rejected pool and bump the auto-refine counter. UI
   *  passes a real handler; AI passes a noop (the AI doesn't need
   *  to nudge itself to fire another turn). */
  onRejectsLanded?: (count: number) => void
}

export interface ApplyDecisionResult {
  /** Ids that actually changed decision (excludes ones already at
   *  the requested state, or committed candidates ignored by the
   *  reject path — see below). */
  changedIds: string[]
}

/** Apply a decision change to a set of candidates.
 *
 *  Reject path skips:
 *    - committed candidates (rejecting a committed song is almost
 *      always a misinterpretation of "replace it" — see CLAUDE.md)
 *    - already-rejected candidates
 *
 *  Unreject path skips:
 *    - non-rejected candidates
 *
 *  Emits a single chat-log line per source: `✗ Rejected: A, B`,
 *  `↩ Unrejected: A, B` for user; the AI variants use 🤖 prefix. */
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
        if (c.committedAt != null) return c
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
      // UI emits one message per candidate so the chat log shows
      // the cumulative cluster, matching the prior setDecision
      // behavior that called appendSystemMessage per click.
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
