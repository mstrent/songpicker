import type { PlanItem } from '../api'
import { isSongSlot } from '../songSlots'
import type { CandidateState } from './helpers'
import type { Assignment } from './resolver'

// Compiles UI events (DnD drops, button clicks, popover picks) into
// the same `Assignment[]` shape the AI tool emits — so both sides
// flow through the shared resolver + executor. See
// docs/unification-plan.md.

/** Translate an item id into its 1-based song-slot position. Returns
 *  null when the item isn't a song slot in `items`. */
function slotIndexOf(itemId: string, items: readonly PlanItem[]): number | null {
  const songSlots = items.filter(isSongSlot)
  const idx = songSlots.findIndex((it) => it.id === itemId)
  return idx >= 0 ? idx + 1 : null
}

/** Drop a candidate onto a song slot. The slot may be empty (fresh
 *  commit), filled with a different committed candidate (overwrite —
 *  resolver evicts), or filled with the same candidate already
 *  committed (no-op idempotent commit). All three resolve to one
 *  assignment. */
export function compileDropCandidateOnSlot(
  candidateId: string,
  slotItem: PlanItem,
  items: readonly PlanItem[],
): Assignment[] {
  const slotIndex = slotIndexOf(slotItem.id, items)
  if (slotIndex == null) return []
  return [{ slotIndex, candidateId }]
}

/** Drop a song slot onto the trash zone. */
export function compileClearSlot(
  slotItem: PlanItem,
  items: readonly PlanItem[],
): Assignment[] {
  const slotIndex = slotIndexOf(slotItem.id, items)
  if (slotIndex == null) return []
  return [{ slotIndex, candidateId: null }]
}

/** Commit a specific candidate to a specific slot via the popover.
 *  Same shape as compileDropCandidateOnSlot — the call site is
 *  different but the intent is identical. */
export function compileCommitToSlot(
  candidateId: string,
  slotItem: PlanItem,
  items: readonly PlanItem[],
): Assignment[] {
  return compileDropCandidateOnSlot(candidateId, slotItem, items)
}

/** Drop slot A onto slot B. The compile rule depends on which is
 *  filled — the user's intent is to move SONGS, not to move EMPTY
 *  PLACEHOLDERS:
 *
 *    - source filled, target empty   → move source's song to target
 *    - source empty,  target filled  → move target's song to source
 *      (mirror — placeholders stay where they are, songs move)
 *    - both filled                   → swap songs (paired commits)
 *    - both empty                    → no-op
 *
 *  Both-filled returns two assignments that swap each slot's
 *  current committed candidate to the other slot. The resolver
 *  detects the swap pair and the executor still runs paired
 *  PATCHes (no PCO reorder) — items stay at their positions, only
 *  the linked songs swap. This means slot-level metadata (notes,
 *  leaders, custom titles you didn't track in slotPlaceholders)
 *  stays bound to the slot's PCO item id, not to whatever song is
 *  currently there. That's the user's expressed mental model. */
export function compileSlotToSlot(
  draggedSlot: PlanItem,
  targetSlot: PlanItem,
  candidates: readonly CandidateState[],
  items: readonly PlanItem[],
): Assignment[] {
  const draggedIndex = slotIndexOf(draggedSlot.id, items)
  const targetIndex = slotIndexOf(targetSlot.id, items)
  if (draggedIndex == null || targetIndex == null) return []
  if (draggedSlot.id === targetSlot.id) return []

  const sourceCandidate = candidates.find(
    (c) => c.assignedSlotItemId === draggedSlot.id && c.committedAt != null,
  )
  const targetCandidate = candidates.find(
    (c) => c.assignedSlotItemId === targetSlot.id && c.committedAt != null,
  )
  const sourceFilled = !!draggedSlot.songId || !!sourceCandidate
  const targetFilled = !!targetSlot.songId || !!targetCandidate

  if (sourceFilled && targetFilled) {
    if (!sourceCandidate || !targetCandidate) {
      // One side has a PCO-direct song without a candidate record —
      // the unified path can't represent it (no candidateId). The
      // call site falls back to its own raw-PCO move handling.
      return []
    }
    return [
      { slotIndex: draggedIndex, candidateId: targetCandidate.id },
      { slotIndex: targetIndex, candidateId: sourceCandidate.id },
    ]
  }
  if (sourceFilled && !targetFilled) {
    if (!sourceCandidate) return [] // PCO-direct outlier
    return [{ slotIndex: targetIndex, candidateId: sourceCandidate.id }]
  }
  if (!sourceFilled && targetFilled) {
    if (!targetCandidate) return [] // PCO-direct outlier
    return [{ slotIndex: draggedIndex, candidateId: targetCandidate.id }]
  }
  // Both empty — nothing to move.
  return []
}
