import type { PlanItem } from './api'
import type { CandidateMatch } from './useCandidatePool'

// Pure helpers for deriving what the candidate pool should *show*.
// "Committed" is derived state, not stored (see CLAUDE.md architecture
// philosophy) — a candidate is committed iff its matched library song
// currently fills a plan slot. Both useCandidatePool's
// isCandidateCommitted and the suggestion-list filter go through here
// so the two paths can't drift.

/** True iff the candidate's matched song currently fills a plan slot. */
export function isCommittedSong(
  candidate: { song?: { id?: string } | null },
  items: readonly Pick<PlanItem, 'songId'>[],
): boolean {
  const id = candidate.song?.id
  if (!id) return false
  return items.some((it) => it.songId === id)
}

/**
 * The candidates the suggestion list should render as active cards:
 * not rejected and not currently committed to a slot. Committed songs
 * live only on the schedule; clearing a slot un-commits the candidate,
 * which makes it reappear here automatically.
 */
export function selectActiveCandidates(
  candidates: readonly CandidateMatch[],
  items: readonly Pick<PlanItem, 'songId'>[],
): CandidateMatch[] {
  return candidates.filter(
    (c) => c.decision !== 'reject' && !isCommittedSong(c, items),
  )
}
