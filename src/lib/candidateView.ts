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

/**
 * Manual reorder of the candidate pool: move `draggedId` to immediately
 * before `beforeId`, or to the end when `beforeId` is null. Order is the
 * array order itself (no per-candidate rank field). Because
 * selectActiveCandidates preserves array order, moving relative to a
 * visible card produces the right visible order while interleaved
 * rejected/committed entries keep their relative position.
 *
 * No-op (returns a copy) when the dragged id is missing, equals the
 * target, or the target id isn't found — the drag layer should only
 * ever pass ids that are present, but guard so a stale id can't drop a
 * card into a surprising place.
 */
export function reorderCandidates(
  candidates: readonly CandidateMatch[],
  draggedId: string,
  beforeId: string | null,
): CandidateMatch[] {
  const dragged = candidates.find((c) => c.id === draggedId)
  if (!dragged) return [...candidates]
  if (beforeId === draggedId) return [...candidates]
  if (beforeId !== null && !candidates.some((c) => c.id === beforeId)) {
    return [...candidates]
  }
  const without = candidates.filter((c) => c.id !== draggedId)
  if (beforeId === null) return [...without, dragged]
  const at = without.findIndex((c) => c.id === beforeId)
  without.splice(at, 0, dragged)
  return without
}
