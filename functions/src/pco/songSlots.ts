import type { PlanItem } from './types'

// Mirror of the client-side detector in src/lib/songSlots.ts. Both sides must
// agree on what counts as a song slot or the badge in the list view won't
// match the slots shown on the plan detail page.
export function isSongSlot(it: PlanItem): boolean {
  if (it.itemType === 'song') return true
  if (it.songId != null) return true
  return /^(song\s+\d+|(opening|closing)\s+song)$/i.test(it.title.trim())
}

export function countSongs(items: PlanItem[]): {
  filled: number
  total: number
} {
  const slots = items.filter(isSongSlot)
  return {
    filled: slots.filter((s) => s.songId != null).length,
    total: slots.length,
  }
}
