import type { PlanItem } from './api'

// Mirror of functions/src/pco/songSlots.ts. Keep these in sync — the list
// view's song-progress badge comes from the server-counted version, but the
// plan detail page applies this client copy when rendering items.
export function isSongSlot(it: PlanItem): boolean {
  if (it.itemType === 'song') return true
  if (it.songId != null) return true
  return /^(song\s+\d+|(opening|closing)\s+song)$/i.test(it.title.trim())
}
