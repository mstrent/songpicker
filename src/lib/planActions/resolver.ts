import type { PlanItem } from '../api'
import { isSongSlot } from '../songSlots'
import {
  buildKnownSongTitles,
  detectSwapPairs,
  fallbackSlotTitle as defaultFallbackSlotTitle,
  findEvictionTarget,
  placeholderForSlot,
  preTurnSlotPlaceholders,
  resolveRestoreTitle,
  type AssignmentLike,
  type CandidateState,
} from './helpers'

// Pure planning layer for slot-state changes. Both AI tool calls
// (set_slot_contents) and UI events (DnD, button clicks, popovers)
// compile to an `Assignment[]`; this module turns that + a state
// snapshot into a fully-resolved Plan that the executor can apply
// without further decisions. No React state, no I/O — see
// docs/unification-plan.md.

/** Raw assignment shape — matches the AI tool input directly so AI
 *  can hand the resolver its assignments unchanged. */
export interface Assignment {
  slotIndex: number
  candidateId: string | null
}

export interface ResolverState {
  items: readonly PlanItem[]
  /** Pre-turn snapshot of every candidate. Includes committed,
   *  uncommitted, and rejected. The resolver does NOT mutate this. */
  candidates: readonly CandidateState[]
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
  /** Title to PATCH onto the slot when clearing — the resolver
   *  applies the persisted-placeholder → candidate-prior →
   *  fallback priority order. */
  restoreTitle: string
  /** Candidate currently committed at this slot, if any. The
   *  executor will reset its committedAt + emit a chat message. */
  occupant: CandidateState | null
}

export interface ResolvedCommit {
  kind: 'commit'
  slotItemId: string
  slotIndex: number
  slotItem: PlanItem
  candidate: CandidateState
  songId: string
  songTitle: string
  /** True iff this candidate is currently committed at a different
   *  slot — implies an additional source-clear PCO op. */
  isMove: boolean
  fromSlotItemId?: string
  fromSlotIndex?: number
  fromSlotItem?: PlanItem
  fromSlotRestoreTitle?: string
  /** Placeholder to capture as the new candidate's priorSlotTitle.
   *  Inherits from preTurnSlotPlaceholders when available so swaps
   *  preserve the original placeholder mid-turn. */
  newPriorSlotTitle: string | null
  /** A different candidate currently committed at the TARGET slot
   *  (overwrite case). The executor will reset it back to pending. */
  evicted: CandidateState | null
}

export type ResolvedEntry = ResolvedClear | ResolvedCommit

export interface Plan {
  resolved: ResolvedEntry[]
  /** ⚠ messages for skipped / invalid entries. Kept separate from
   *  resolved so the executor surfaces them as system messages
   *  without firing PCO calls. */
  warnings: string[]
  /** Index → partner-index map for resolved commits that form a
   *  swap pair (X going to Y's slot, Y going to X's slot). The
   *  executor uses this to emit ONE "swapped" chat message rather
   *  than two separate "committed" messages. Indices reference the
   *  `resolved` array. */
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

  const { items, candidates, slotPlaceholders } = state
  const warnings: string[] = []

  // Index for slot-position ↔ item-id translation. AI uses 1-based
  // slotIndex among song slots; PCO operates on item IDs. These
  // also tell us which slots actually exist (an out-of-range
  // slotIndex becomes a warning).
  const songSlotItems = items.filter(isSongSlot)
  const itemIdBySlotIndex = new Map<number, string>()
  const slotIndexByItemId = new Map<string, number>()
  songSlotItems.forEach((it, idx) => {
    slotIndexByItemId.set(it.id, idx + 1)
    itemIdBySlotIndex.set(idx + 1, it.id)
  })

  const knownSongTitles = buildKnownSongTitles(candidates, items)
  const preTurnPlaceholders = preTurnSlotPlaceholders(
    candidates,
    knownSongTitles,
  )
  const candidateById = new Map(candidates.map((c) => [c.id, c]))
  const fallback = (id: string) => defaultFallbackSlotTitle(id, items)

  // Live tracker — where each committed candidate currently sits,
  // accounting for in-turn moves so a later assignment sees the
  // effect of an earlier one. Mutated locally as we resolve.
  const liveCommittedSlot = new Map<string, string>()
  for (const c of candidates) {
    if (c.committedAt && c.assignedSlotItemId) {
      liveCommittedSlot.set(c.id, c.assignedSlotItemId)
    }
  }

  const resolved: ResolvedEntry[] = []

  for (const a of assignments) {
    const slotItemId = itemIdBySlotIndex.get(a.slotIndex)
    if (!slotItemId) {
      warnings.push(
        `AI tried to set song slot ${a.slotIndex}, but no such slot exists — skipped`,
      )
      continue
    }
    const slotItem = items.find((it) => it.id === slotItemId)
    if (!slotItem) continue

    if (a.candidateId == null) {
      const occupant =
        candidates.find(
          (c) =>
            c.assignedSlotItemId === slotItemId && c.committedAt != null,
        ) ?? null
      const restoreTitle = resolveRestoreTitle({
        slotItemId,
        slotPlaceholders,
        candidatePriorSlotTitle: occupant?.priorSlotTitle,
        knownSongTitles,
        fallbackForSlot: fallback,
      })
      resolved.push({
        kind: 'clear',
        slotItemId,
        slotIndex: a.slotIndex,
        slotItem,
        restoreTitle,
        occupant,
      })
      if (occupant) liveCommittedSlot.delete(occupant.id)
      continue
    }

    const candidate = candidateById.get(a.candidateId)
    if (!candidate) {
      warnings.push(
        `AI referenced an unknown candidate (${a.candidateId}) — skipped`,
      )
      continue
    }
    if (!candidate.song?.id) {
      warnings.push(
        `AI tried to commit "${candidate.suggestion.title}" but it isn't matched to a song in your Planning Center library — skipped`,
      )
      continue
    }

    const songId = candidate.song.id
    const songTitle = candidate.suggestion.title

    const currentSlot = liveCommittedSlot.get(candidate.id)
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
            candidatePriorSlotTitle: candidate.priorSlotTitle,
            // No taint check at commit-time move-source — trust the
            // candidate's prior since the source slot's title was
            // the one we captured at original commit.
            fallbackForSlot: fallback,
          })
        : undefined

    const newPriorSlotTitle =
      preTurnPlaceholders.get(slotItemId) ??
      placeholderForSlot(slotItem, slotPlaceholders, fallback)

    const evicted = findEvictionTarget(slotItemId, candidates, candidate.id)

    resolved.push({
      kind: 'commit',
      slotItemId,
      slotIndex: a.slotIndex,
      slotItem,
      candidate,
      songId,
      songTitle,
      isMove,
      fromSlotItemId,
      fromSlotIndex,
      fromSlotItem,
      fromSlotRestoreTitle,
      newPriorSlotTitle,
      evicted,
    })

    liveCommittedSlot.set(candidate.id, slotItemId)
    if (evicted) liveCommittedSlot.delete(evicted.id)
  }

  // Swap-pair detection on commits only — clears can't pair. The
  // helper keys returned indices into the array we pass in, so we
  // pass `resolved` itself (clears project to candidateId: null and
  // the helper skips them).
  const swapPairs = detectSwapPairs(
    resolved.map((r): AssignmentLike => {
      if (r.kind === 'clear') {
        return { slotItemId: r.slotItemId, candidateId: null }
      }
      return { slotItemId: r.slotItemId, candidateId: r.candidate.id }
    }),
    candidates,
  )

  return { resolved, warnings, swapPairs }
}
