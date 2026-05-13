import type { PlanItem } from '../api'
import { isSongSlot } from '../songSlots'
import type { Assignment } from './resolver'

// Compiles UI events (DnD drops, button clicks, popover picks) into
// the same `Assignment[]` shape the AI tool emits, so both sides
// flow through the shared resolver + executor. See
// docs/unification-plan.md.
//
// Phase 6 dropped all candidate dependencies. Compile functions
// operate on items (PCO state) plus, where the user's intent comes
// from a candidate (e.g., DnD candidate onto slot), the candidate's
// matched library song. The resolver figures out is-this-a-move /
// is-there-an-eviction / etc. by inspecting items.

function slotIndexOf(itemId: string, items: readonly PlanItem[]): number | null {
  const songSlots = items.filter(isSongSlot)
  const idx = songSlots.findIndex((it) => it.id === itemId)
  return idx >= 0 ? idx + 1 : null
}

/** Minimal candidate shape the compile functions need — just the
 *  matched library song + the user-facing title. */
export interface CompileCandidate {
  song?: { id?: string; title?: string | null } | null | undefined
  suggestion: { title: string }
}

/** Drop a candidate onto a song slot. The slot may be empty (fresh
 *  commit), filled with a different song (overwrite — resolver
 *  handles eviction), or filled with the same song (no-op
 *  idempotent commit). All three resolve to one assignment.
 *
 *  Returns [] when the candidate isn't matched to a library song
 *  (we have no songId to commit). Caller should warn the user. */
export function compileDropCandidateOnSlot(
  candidate: CompileCandidate,
  slotItem: PlanItem,
  items: readonly PlanItem[],
): Assignment[] {
  const slotIndex = slotIndexOf(slotItem.id, items)
  if (slotIndex == null) return []
  if (!candidate.song?.id) return []
  return [
    {
      slotIndex,
      song: { id: candidate.song.id, title: candidate.suggestion.title },
    },
  ]
}

/** Drop a song slot onto the trash zone. */
export function compileClearSlot(
  slotItem: PlanItem,
  items: readonly PlanItem[],
): Assignment[] {
  const slotIndex = slotIndexOf(slotItem.id, items)
  if (slotIndex == null) return []
  return [{ slotIndex, song: null }]
}

/** Commit a specific candidate to a specific slot via the popover.
 *  Same shape as compileDropCandidateOnSlot. */
export function compileCommitToSlot(
  candidate: CompileCandidate,
  slotItem: PlanItem,
  items: readonly PlanItem[],
): Assignment[] {
  return compileDropCandidateOnSlot(candidate, slotItem, items)
}

/** Drop slot A onto slot B. Operates purely on items (PCO state) —
 *  whichever slot has a song moves it to the other side; if both
 *  have songs, it's a swap; if neither, it's a no-op. PCO-direct
 *  songs and candidate-tracked songs are handled identically (no
 *  candidate state needed) — the resolver derives isMove and
 *  eviction from items. */
export function compileSlotToSlot(
  draggedSlot: PlanItem,
  targetSlot: PlanItem,
  items: readonly PlanItem[],
): Assignment[] {
  const draggedIndex = slotIndexOf(draggedSlot.id, items)
  const targetIndex = slotIndexOf(targetSlot.id, items)
  if (draggedIndex == null || targetIndex == null) return []
  if (draggedSlot.id === targetSlot.id) return []

  const sourceFilled = !!draggedSlot.songId && !!draggedSlot.songTitle
  const targetFilled = !!targetSlot.songId && !!targetSlot.songTitle

  if (sourceFilled && targetFilled) {
    return [
      {
        slotIndex: draggedIndex,
        song: { id: targetSlot.songId!, title: targetSlot.songTitle! },
      },
      {
        slotIndex: targetIndex,
        song: { id: draggedSlot.songId!, title: draggedSlot.songTitle! },
      },
    ]
  }
  if (sourceFilled && !targetFilled) {
    return [
      {
        slotIndex: targetIndex,
        song: { id: draggedSlot.songId!, title: draggedSlot.songTitle! },
      },
    ]
  }
  if (!sourceFilled && targetFilled) {
    return [
      {
        slotIndex: draggedIndex,
        song: { id: targetSlot.songId!, title: targetSlot.songTitle! },
      },
    ]
  }
  return []
}
