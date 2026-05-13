import { getFirestore } from 'firebase-admin/firestore'
import { isSongSlot } from './pco/songSlots'
import type { PlanItem } from './pco/types'

// Per-user, per-plan map of song-slot itemId → the title PCO had on
// the slot when it was empty. Captured + refreshed on every plan
// load (server-side, inside getPlanContext) so we have a real
// placeholder to restore on slot clears, even when the slot was
// filled before songpicker first observed it.
//
// Sync rule below is "only update when the slot is empty" — a slot
// whose songId is set has its title rewritten to the song's name
// (PCO does this on link), so updating the captured value would
// remember a song name as the placeholder and defeat the purpose.
//
// Cache-invalidation: getPlanContext is called fresh on every plan
// open + after every commit/clear (the SPA invalidates its session
// cache in the action layer). So whenever PCO state could have
// changed, we re-sync. A worship leader who renames an empty slot
// in PCO between songpicker visits gets the new placeholder picked
// up on their next load.

const COLLECTION = 'slotPlaceholders'

const docRef = (uid: string, planId: string) =>
  getFirestore().doc(`${COLLECTION}/${uid}/plans/${planId}`)

export async function loadSlotPlaceholders(
  uid: string,
  planId: string,
): Promise<Record<string, string>> {
  const snap = await docRef(uid, planId).get()
  if (!snap.exists) return {}
  const data = snap.data() ?? {}
  const titles = (data as { titles?: unknown }).titles
  if (!titles || typeof titles !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(titles as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) {
      out[k] = v
    }
  }
  return out
}

// Reconcile the persisted map with the current PCO items. Returns
// the post-sync map (so the caller can ship it back in the same
// response without an extra round-trip). Writes to Firestore only
// when something actually changed — most plan loads are no-ops.
export async function syncSlotPlaceholders(
  uid: string,
  planId: string,
  items: PlanItem[],
): Promise<Record<string, string>> {
  const existing = await loadSlotPlaceholders(uid, planId)
  const next: Record<string, string> = { ...existing }
  let changed = false
  for (const item of items) {
    if (!isSongSlot(item)) continue
    if (item.songId) continue
    const title = item.title?.trim()
    if (!title) continue
    if (next[item.id] !== title) {
      next[item.id] = title
      changed = true
    }
  }
  if (!changed) return next
  await docRef(uid, planId).set(
    { titles: next, updatedAt: new Date() },
    { merge: false },
  )
  return next
}
