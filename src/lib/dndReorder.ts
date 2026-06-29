// Pure helper for drag-to-reorder of the candidate pool.
//
// Given the pointer's Y and the vertical spans of the rendered cards (in
// list order), return the index where the dragged card should be inserted
// — i.e. how many cards sit *above* the pointer's line. The insertion
// indicator renders before card[index] (or after the last card when index
// === cards.length), and the drop resolves the same index to a beforeId,
// so the line and the drop stay in lockstep by construction.
//
// Computing this from the pointer position at the list level (rather than
// per-card hover) means the gaps between cards, the space above the first
// card, and the runway below the last card are all live — there are no
// dead zones where the line vanishes or a drop silently no-ops.

export interface VSpan {
  top: number
  bottom: number
}

export function reorderInsertIndex(
  pointerY: number,
  spans: readonly VSpan[],
): number {
  let count = 0
  for (const s of spans) {
    if (pointerY > (s.top + s.bottom) / 2) count++
  }
  return count
}
