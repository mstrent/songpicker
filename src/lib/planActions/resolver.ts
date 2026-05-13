import type { PlanItem } from '../api'
import { isSongSlot } from '../songSlots'
import {
  detectSwapPairs,
  fallbackSlotTitle as defaultFallbackSlotTitle,
  placeholderForSlot,
  resolveRestoreTitle,
  type AssignmentLike,
} from './helpers'

// Pure planning layer for slot-state changes. Both AI tool calls
// (set_slot_contents) and UI events (DnD, button clicks, popovers)
// compile to an `Assignment[]`; this module turns that + a state
// snapshot into a fully-resolved Plan that the executor can apply.
//
// Phase 6 changed the assignment shape from candidate-id to song-ref
// so that the resolver works for ANY song in PCO, including ones
// placed via PCO web UI that have no candidate record. PCO is the
// source of truth for plan state; the resolver operates on that.

/** A slot-state intent: "this slot should contain this song" (or
 *  null to be empty). */
export interface Assignment {
  slotIndex: number
  song: { id: string; title: string } | null
}

export interface ResolverState {
  items: readonly PlanItem[]
  slotPlaceholders: Readonly<Record<string, string>>
}

export interface ResolverOptions {
  /** When true (auto-refresh AI turns), the resolver returns no
   *  ops + a single warning. PCO writes are forbidden during
   *  auto-refresh. */
  autoRefresh?: boolean
}

export interface ResolvedClear {
  kind: 'clear'
  slotItemId: string
  slotIndex: number
  slotItem: PlanItem
  /** Title to PATCH onto the slot when clearing. */
  restoreTitle: string
  /** Title of the song currently at this slot (about to be cleared)
   *  — for chat-message rendering. */
  evictedSongTitle: string | null
}

export interface ResolvedCommit {
  kind: 'commit'
  slotItemId: string
  slotIndex: number
  slotItem: PlanItem
  songId: string
  songTitle: string
  /** True iff this song is currently linked to a different slot —
   *  inferred from items.songId. Implies an additional source-clear
   *  PCO op (deduped if the source is also a commit target this
   *  turn). */
  isMove: boolean
  /** When isMove is true, the slot the song is moving FROM. */
  fromSlotItem?: PlanItem
  fromSlotItemId?: string
  fromSlotIndex?: number
  fromSlotRestoreTitle?: string
  /** Placeholder to capture for this slot in case it's later
   *  cleared. Inherits from preTurn snapshot for swaps so the
   *  position binding survives mid-turn. */
  newPriorSlotTitle: string | null
  /** Title of the song currently at the TARGET slot (about to be
   *  displaced) — for chat-message rendering. Null when the target
   *  was empty. */
  evictedSongTitle: string | null
}

export type ResolvedEntry = ResolvedClear | ResolvedCommit

export interface Plan {
  resolved: ResolvedEntry[]
  warnings: string[]
  swapPairs: Map<number, number>
}

export function resolvePlan(
  assignments: readonly Assignment[],
  state: ResolverState,
  options: ResolverOptions = {},
): Plan {
  if (options.autoRefresh) {
    return {
      resolved: [],
      warnings: [
        'AI tried to change song slots during auto-refresh — skipped (Planning Center writes require explicit direction)',
      ],
      swapPairs: new Map(),
    }
  }

  const { items, slotPlaceholders } = state
  const warnings: string[] = []

  const songSlotItems = items.filter(isSongSlot)
  const itemIdBySlotIndex = new Map<number, string>()
  const slotIndexByItemId = new Map<string, number>()
  songSlotItems.forEach((it, idx) => {
    slotIndexByItemId.set(it.id, idx + 1)
    itemIdBySlotIndex.set(idx + 1, it.id)
  })

  const fallback = (id: string) => defaultFallbackSlotTitle(id, items)

  // Pre-turn snapshot of every slot's placeholder. Mid-turn moves
  // (a swap is two assignments) inherit from this so the second
  // commit captures the original placeholder, not the mid-turn one.
  const preTurnPlaceholders = new Map<string, string>()
  for (const item of items) {
    if (!isSongSlot(item)) continue
    const ph = placeholderForSlot(item, slotPlaceholders, fallback)
    if (ph) preTurnPlaceholders.set(item.id, ph)
  }

  // Live tracker — where each song currently sits, accounting for
  // in-turn moves so a later assignment sees an earlier one. Keyed
  // by songId.
  const liveSongAtSlot = new Map<string, string>()
  const liveSlotSong = new Map<string, { id: string; title: string }>()
  for (const it of items) {
    if (it.songId && it.songTitle) {
      liveSongAtSlot.set(it.songId, it.id)
      liveSlotSong.set(it.id, { id: it.songId, title: it.songTitle })
    }
  }

  const resolved: ResolvedEntry[] = []

  for (const a of assignments) {
    const slotItemId = itemIdBySlotIndex.get(a.slotIndex)
    if (!slotItemId) {
      warnings.push(
        `tried to set song slot ${a.slotIndex}, but no such slot exists — skipped`,
      )
      continue
    }
    const slotItem = items.find((it) => it.id === slotItemId)
    if (!slotItem) continue

    if (a.song == null) {
      // Clear
      const occupant = liveSlotSong.get(slotItemId)
      const restoreTitle = resolveRestoreTitle({
        slotItemId,
        slotPlaceholders,
        fallbackForSlot: fallback,
      })
      resolved.push({
        kind: 'clear',
        slotItemId,
        slotIndex: a.slotIndex,
        slotItem,
        restoreTitle,
        evictedSongTitle: occupant?.title ?? null,
      })
      if (occupant) {
        liveSongAtSlot.delete(occupant.id)
        liveSlotSong.delete(slotItemId)
      }
      continue
    }

    const { id: songId, title: songTitle } = a.song

    // isMove: is this song currently at a DIFFERENT slot?
    const currentSlot = liveSongAtSlot.get(songId)
    const isMove = currentSlot !== undefined && currentSlot !== slotItemId
    const fromSlotItemId = isMove ? currentSlot : undefined
    const fromSlotItem = fromSlotItemId
      ? items.find((it) => it.id === fromSlotItemId)
      : undefined
    const fromSlotIndex = fromSlotItemId
      ? slotIndexByItemId.get(fromSlotItemId)
      : undefined
    const fromSlotRestoreTitle =
      isMove && fromSlotItemId
        ? resolveRestoreTitle({
            slotItemId: fromSlotItemId,
            slotPlaceholders,
            fallbackForSlot: fallback,
          })
        : undefined

    const newPriorSlotTitle =
      preTurnPlaceholders.get(slotItemId) ??
      placeholderForSlot(slotItem, slotPlaceholders, fallback)

    // Eviction at target slot — what song is currently there
    // (different from what we're committing)?
    const occupantAtTarget = liveSlotSong.get(slotItemId)
    const evictedSongTitle =
      occupantAtTarget && occupantAtTarget.id !== songId
        ? occupantAtTarget.title
        : null

    resolved.push({
      kind: 'commit',
      slotItemId,
      slotIndex: a.slotIndex,
      slotItem,
      songId,
      songTitle,
      isMove,
      fromSlotItemId,
      fromSlotIndex,
      fromSlotItem,
      fromSlotRestoreTitle,
      newPriorSlotTitle,
      evictedSongTitle,
    })

    // Update live trackers — song moved to slotItemId; its old
    // location (if any) is empty; whatever was at slotItemId is
    // displaced.
    if (isMove && fromSlotItemId) {
      liveSlotSong.delete(fromSlotItemId)
    }
    if (occupantAtTarget && occupantAtTarget.id !== songId) {
      liveSongAtSlot.delete(occupantAtTarget.id)
    }
    liveSongAtSlot.set(songId, slotItemId)
    liveSlotSong.set(slotItemId, { id: songId, title: songTitle })
  }

  // Swap-pair detection on commits only. The helper expects
  // {slotItemId, songId}; clears project to songId: null and the
  // helper skips them.
  const swapPairs = detectSwapPairs(
    resolved.map((r): AssignmentLike => {
      if (r.kind === 'clear') {
        return { slotItemId: r.slotItemId, songId: null }
      }
      return { slotItemId: r.slotItemId, songId: r.songId }
    }),
    items,
  )

  return { resolved, warnings, swapPairs }
}

// Re-export so the property `slotItemId` field shows up in the
// fromSlotItemId optional shape — TypeScript needs it referenced
// somewhere when the type is structural. (No-op runtime usage.)
export type { PlanItem }
