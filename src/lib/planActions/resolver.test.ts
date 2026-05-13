import { describe, expect, it } from 'vitest'
import type { PlanItem } from '../api'
import { resolvePlan, type Assignment, type ResolverState } from './resolver'

function makeItem(partial: Partial<PlanItem> & Pick<PlanItem, 'id'>): PlanItem {
  return {
    id: partial.id,
    sequence: partial.sequence ?? 1,
    title: partial.title ?? '',
    itemType: partial.itemType ?? 'song',
    songId: partial.songId ?? null,
    songTitle: partial.songTitle ?? null,
    songAuthor: partial.songAuthor ?? null,
    songCcli: partial.songCcli ?? null,
    arrangementId: partial.arrangementId ?? null,
    keyId: partial.keyId ?? null,
    keyName: partial.keyName ?? null,
    description: partial.description ?? null,
    notes: partial.notes ?? [],
    leaders: partial.leaders ?? [],
  }
}

function defaultPlan(overrides: Record<number, Partial<PlanItem>> = {}): PlanItem[] {
  return [1, 2, 3, 4, 5].map((n) =>
    makeItem({
      id: `s${n}`,
      sequence: n,
      title: `Song ${n}`,
      ...overrides[n],
    }),
  )
}

const stateOf = (
  items: PlanItem[] = defaultPlan(),
  slotPlaceholders: Record<string, string> = {},
): ResolverState => ({ items, slotPlaceholders })

describe('resolvePlan: trivial', () => {
  it('empty assignments → empty plan', () => {
    const plan = resolvePlan([], stateOf())
    expect(plan.resolved).toEqual([])
    expect(plan.warnings).toEqual([])
    expect(plan.swapPairs.size).toBe(0)
  })

  it('autoRefresh → single warning, no resolved', () => {
    const plan = resolvePlan(
      [{ slotIndex: 1, song: { id: 'sX', title: 'X' } }],
      stateOf(),
      { autoRefresh: true },
    )
    expect(plan.resolved).toEqual([])
    expect(plan.warnings[0]).toMatch(/auto-refresh/)
  })

  it('out-of-range slotIndex → warning', () => {
    const plan = resolvePlan(
      [{ slotIndex: 99, song: null }],
      stateOf(),
    )
    expect(plan.resolved).toEqual([])
    expect(plan.warnings[0]).toMatch(/song slot 99/)
  })
})

describe('resolvePlan: clears', () => {
  it('clears empty slot with no occupant — fallback restore title', () => {
    const plan = resolvePlan(
      [{ slotIndex: 3, song: null }],
      stateOf(),
    )
    expect(plan.resolved).toHaveLength(1)
    const r = plan.resolved[0]
    if (r.kind !== 'clear') throw new Error('expected clear')
    expect(r.slotItemId).toBe('s3')
    expect(r.restoreTitle).toBe('Song 3')
    expect(r.evictedSongTitle).toBeNull()
  })

  it('clears persisted-placeholder slot — uses placeholder', () => {
    const items = defaultPlan({
      5: { songId: 'song-bml', songTitle: 'Build My Life' },
    })
    const plan = resolvePlan(
      [{ slotIndex: 5, song: null }],
      stateOf(items, { s5: 'Closing song' }),
    )
    const r = plan.resolved[0]
    if (r.kind !== 'clear') throw new Error('expected clear')
    expect(r.restoreTitle).toBe('Closing song')
    expect(r.evictedSongTitle).toBe('Build My Life')
  })
})

describe('resolvePlan: fresh commits', () => {
  it('commits a song to an empty slot', () => {
    const plan = resolvePlan(
      [{ slotIndex: 1, song: { id: 'song-bml', title: 'Build My Life' } }],
      stateOf(),
    )
    const r = plan.resolved[0]
    if (r.kind !== 'commit') throw new Error('expected commit')
    expect(r.slotItemId).toBe('s1')
    expect(r.songId).toBe('song-bml')
    expect(r.songTitle).toBe('Build My Life')
    expect(r.isMove).toBe(false)
    expect(r.evictedSongTitle).toBeNull()
    expect(r.newPriorSlotTitle).toBe('Song 1')
  })
})

describe('resolvePlan: overwrite (eviction)', () => {
  it('marks evictedSongTitle when target slot is filled', () => {
    const items = defaultPlan({
      1: { songId: 'song-gog', songTitle: 'Goodness of God' },
    })
    const plan = resolvePlan(
      [{ slotIndex: 1, song: { id: 'song-bml', title: 'Build My Life' } }],
      stateOf(items),
    )
    const r = plan.resolved[0]
    if (r.kind !== 'commit') throw new Error('expected commit')
    expect(r.evictedSongTitle).toBe('Goodness of God')
  })

  it('does NOT mark eviction when re-committing same song to same slot', () => {
    const items = defaultPlan({
      1: { songId: 'song-x', songTitle: 'X' },
    })
    const plan = resolvePlan(
      [{ slotIndex: 1, song: { id: 'song-x', title: 'X' } }],
      stateOf(items),
    )
    const r = plan.resolved[0]
    if (r.kind !== 'commit') throw new Error('expected commit')
    expect(r.evictedSongTitle).toBeNull()
    expect(r.isMove).toBe(false)
  })
})

describe('resolvePlan: moves', () => {
  it('flags isMove when song currently lives at a different slot', () => {
    const items = defaultPlan({
      2: { songId: 'song-bml', songTitle: 'Build My Life' },
    })
    const plan = resolvePlan(
      [{ slotIndex: 4, song: { id: 'song-bml', title: 'Build My Life' } }],
      stateOf(items),
    )
    const r = plan.resolved[0]
    if (r.kind !== 'commit') throw new Error('expected commit')
    expect(r.isMove).toBe(true)
    expect(r.fromSlotItemId).toBe('s2')
    expect(r.fromSlotIndex).toBe(2)
    expect(r.fromSlotRestoreTitle).toBe('Song 2')
  })

  it('move-source restore prefers persisted placeholder', () => {
    const items = defaultPlan({
      5: { songId: 'song-bml', songTitle: 'Build My Life' },
    })
    const plan = resolvePlan(
      [{ slotIndex: 1, song: { id: 'song-bml', title: 'Build My Life' } }],
      stateOf(items, { s5: 'Closing song' }),
    )
    const r = plan.resolved[0]
    if (r.kind !== 'commit') throw new Error('expected commit')
    expect(r.fromSlotRestoreTitle).toBe('Closing song')
  })
})

describe('resolvePlan: swap-pair detection', () => {
  it('detects mutual swap from items state', () => {
    const items = defaultPlan({
      1: { songId: 'song-A', songTitle: 'Song A' },
      2: { songId: 'song-B', songTitle: 'Song B' },
    })
    const assignments: Assignment[] = [
      { slotIndex: 2, song: { id: 'song-A', title: 'Song A' } },
      { slotIndex: 1, song: { id: 'song-B', title: 'Song B' } },
    ]
    const plan = resolvePlan(assignments, stateOf(items))
    expect(plan.resolved).toHaveLength(2)
    expect(plan.swapPairs.get(0)).toBe(1)
    expect(plan.swapPairs.get(1)).toBe(0)
  })

  it('handles swap of PCO-direct songs (no candidate state needed)', () => {
    // The bug from real usage: ISA at slot 7 placed via PCO before
    // songpicker loaded, Surrender at slot 11 also via PCO. Drag
    // ISA onto Surrender. The Phase 6 resolver doesn't care about
    // candidate state; it works purely on items.songId.
    const items = defaultPlan({
      4: { songId: 'song-isa', songTitle: 'I Surrender All' },
      5: { songId: 'song-surrender', songTitle: 'Surrender' },
    })
    const assignments: Assignment[] = [
      { slotIndex: 4, song: { id: 'song-surrender', title: 'Surrender' } },
      { slotIndex: 5, song: { id: 'song-isa', title: 'I Surrender All' } },
    ]
    const plan = resolvePlan(assignments, stateOf(items))
    expect(plan.resolved).toHaveLength(2)
    // Swap detected from items (PCO state) — the chat message
    // collapses to "swapped". isMove on individual entries doesn't
    // matter for correctness because both slots are commit targets
    // in the same turn — any clear we'd add for a move source gets
    // deduped away by the executor.
    expect(plan.swapPairs.size).toBe(2)
    expect(plan.swapPairs.get(0)).toBe(1)
    expect(plan.swapPairs.get(1)).toBe(0)
  })
})

describe('resolvePlan: in-turn live tracking', () => {
  it('a later assignment sees an earlier in-turn move', () => {
    // X at slot 1. Assignment 0: move X to slot 2. Assignment 1:
    // commit Y to slot 1 (now empty after X moved). Y's commit
    // shouldn't be flagged with eviction because slot 1 is empty
    // post-move.
    const items = defaultPlan({
      1: { songId: 'song-X', songTitle: 'X' },
    })
    const plan = resolvePlan(
      [
        { slotIndex: 2, song: { id: 'song-X', title: 'X' } },
        { slotIndex: 1, song: { id: 'song-Y', title: 'Y' } },
      ],
      stateOf(items),
    )
    expect(plan.resolved).toHaveLength(2)
    const r1 = plan.resolved[1]
    if (r1.kind !== 'commit') throw new Error('expected commit')
    // Slot 1 is empty after X moved out, so Y has no eviction.
    expect(r1.evictedSongTitle).toBeNull()
    expect(r1.isMove).toBe(false)
  })
})
