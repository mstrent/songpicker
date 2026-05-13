import { isSongSlot } from '../songSlots'
import type { PlanItem } from '../api'

// Pure helpers for slot-state action paths. Both AI tool handling
// and UI flows depend on these. See docs/unification-plan.md and the
// Architecture philosophy section of CLAUDE.md.
//
// Phase 6 made the helpers operate purely on PCO-side data (items +
// slotPlaceholders). They no longer take candidate state — the
// candidate pool is a separate concept (see CLAUDE.md). "Is X
// committed?" is derived by the UI from items.songId; the helpers
// don't model it.

/** Minimal candidate shape used by the candidate-side modules
 *  (decisions, the AI handlers). Slot-state helpers no longer need
 *  candidates at all. */
export interface CandidateState {
  id: string
  decision: 'pending' | 'reject'
  suggestion: { title: string }
  /** Matched library song, when the candidate has been resolved
   *  against PCO's library. song.id is what the slot-state
   *  operations key off when the user commits this candidate. */
  song?: { id?: string; title?: string | null } | null | undefined
}

/** Capture-time helper for slot-placeholder persistence. PCO
 *  rewrites a slot's `title` attribute to the linked song's name
 *  when a song is linked. So a slot whose `title` equals its
 *  `songTitle` isn't holding a true placeholder — it's holding the
 *  previous song's name. Using that as a placeholder would taint
 *  the next clear's restore. Falling back to the persisted
 *  placeholder (or the position-based "Song N") is strictly better
 *  than carrying a stale song title.
 *
 *  Returns null when the slot has no title at all. */
export function placeholderForSlot(
  slotItem: PlanItem,
  slotPlaceholders: Readonly<Record<string, string>>,
  fallbackForSlot: (itemId: string) => string,
): string | null {
  const title = slotItem.title?.trim() ?? null
  if (!title) return null
  const songTitle = slotItem.songTitle?.trim()
  if (songTitle && songTitle.toLowerCase() === title.toLowerCase()) {
    return slotPlaceholders[slotItem.id] ?? fallbackForSlot(slotItem.id)
  }
  return title
}

/** Resolve the title to PATCH onto a slot when clearing it. Just
 *  the persisted placeholder if we have one, otherwise the
 *  position-based fallback. The pre-Phase-6 candidate-prior tier
 *  is gone — that was per-candidate state which no longer exists
 *  (candidates' "committed slot" is derived, not stored). */
export function resolveRestoreTitle(input: {
  slotItemId: string
  slotPlaceholders: Readonly<Record<string, string>>
  fallbackForSlot: (itemId: string) => string
}): string {
  const persisted = input.slotPlaceholders[input.slotItemId]?.trim()
  if (persisted) return persisted
  return input.fallbackForSlot(input.slotItemId)
}

/** Position-based fallback "Song N" where N is the 1-based index of
 *  this item among song slots in the current items array. Returns
 *  "Song" if the item isn't found among song slots. */
export function fallbackSlotTitle(
  itemId: string,
  items: readonly PlanItem[] | null | undefined,
): string {
  const songSlotItems = (items ?? []).filter(isSongSlot)
  const idx = songSlotItems.findIndex((s) => s.id === itemId)
  return idx >= 0 ? `Song ${idx + 1}` : 'Song'
}

/** Detect swap pairs in an assignment list: assignment X is a swap
 *  partner of assignment Y if X wants to put song A in slot α and Y
 *  wants to put song B in slot β AND PCO currently has A at β and B
 *  at α. Used to render a single "swapped" chat message instead of
 *  two commits.
 *
 *  Operates on items.songId — no candidate state involved. */
export interface AssignmentLike {
  slotItemId: string
  songId: string | null
}
export function detectSwapPairs(
  assignments: readonly AssignmentLike[],
  items: readonly PlanItem[] | null | undefined,
): Map<number, number> {
  const partner = new Map<number, number>()
  // Index for fast "what song is currently at slot X?" lookups.
  const songAtSlot = new Map<string, string>()
  for (const it of items ?? []) {
    if (it.songId) songAtSlot.set(it.id, it.songId)
  }
  for (let i = 0; i < assignments.length; i++) {
    if (partner.has(i)) continue
    const ai = assignments[i]
    if (ai.songId == null) continue
    if (!songAtSlot.has(ai.slotItemId)) continue
    for (let j = i + 1; j < assignments.length; j++) {
      if (partner.has(j)) continue
      const aj = assignments[j]
      if (aj.songId == null) continue
      if (!songAtSlot.has(aj.slotItemId)) continue
      // i wants to put A in slot α; j wants to put B in slot β.
      // It's a swap iff PCO currently has A at β AND B at α.
      const aLivesAtBeta = songAtSlot.get(aj.slotItemId) === ai.songId
      const bLivesAtAlpha = songAtSlot.get(ai.slotItemId) === aj.songId
      if (aLivesAtBeta && bLivesAtAlpha) {
        partner.set(i, j)
        partner.set(j, i)
        break
      }
    }
  }
  return partner
}
