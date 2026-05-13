import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PlanItem } from '../api'
import {
  executePlan,
  type ExecutorDeps,
  type PcoCallables,
} from './executor'
import { synthesizeMessages } from './messages'
import { resolvePlan, type Plan, type ResolverState } from './resolver'

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

interface Harness {
  items: PlanItem[] | null
  messages: string[]
  refreshCount: number
  pco: {
    placeCalls: Array<{ slotItemId: string; songId: string; songTitle?: string }>
    clearCalls: Array<{ slotItemId: string; restoreTitle?: string }>
  }
  deps: ExecutorDeps
}

function harness(initial: {
  items: PlanItem[]
  failNextPlace?: Error
}): Harness {
  const h: Harness = {
    items: [...initial.items],
    messages: [],
    refreshCount: 0,
    pco: { placeCalls: [], clearCalls: [] },
    deps: undefined as unknown as ExecutorDeps,
  }
  let failNext = initial.failNextPlace ?? null
  const pco: PcoCallables = {
    placeSongInSlot: async (params) => {
      if (failNext) {
        const err = failNext
        failNext = null
        throw err
      }
      h.pco.placeCalls.push({
        slotItemId: params.slotItemId,
        songId: params.songId,
        songTitle: params.songTitle,
      })
    },
    clearSongFromSlot: async (params) => {
      h.pco.clearCalls.push({
        slotItemId: params.slotItemId,
        restoreTitle: params.restoreTitle,
      })
    },
  }
  h.deps = {
    serviceTypeId: 'st-1',
    planId: 'plan-1',
    pco,
    setItems: (update) => {
      h.items = update(h.items)
    },
    appendSystemMessage: (msg) => {
      h.messages.push(msg)
    },
    refreshPlanState: async () => {
      h.refreshCount++
    },
  }
  return h
}

function planFor(
  assignments: { slotIndex: number; song: { id: string; title: string } | null }[],
  items: PlanItem[],
  slotPlaceholders: Record<string, string> = {},
): Plan {
  const state: ResolverState = { items, slotPlaceholders }
  return resolvePlan(assignments, state)
}

describe('executePlan: empty', () => {
  it('returns immediately on empty plan, no PCO, no refresh', async () => {
    const h = harness({ items: defaultPlan() })
    const plan = planFor([], defaultPlan())
    const result = await executePlan(plan, h.deps)
    expect(result.pcoWritesFired).toBe(false)
    expect(h.pco.placeCalls).toEqual([])
    expect(h.refreshCount).toBe(0)
  })
})

describe('executePlan: fresh commit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T12:00:00Z'))
  })

  it('optimistically updates items, fires placeSongInSlot, refreshes', async () => {
    const items = defaultPlan()
    const h = harness({ items })
    const plan = planFor(
      [{ slotIndex: 1, song: { id: 'song-bml', title: 'Build My Life' } }],
      items,
    )
    const result = await executePlan(plan, h.deps, { source: 'user' })
    expect(result.pcoWritesFired).toBe(true)
    expect(h.items?.[0].songId).toBe('song-bml')
    expect(h.items?.[0].songTitle).toBe('Build My Life')
    expect(h.pco.placeCalls).toEqual([
      { slotItemId: 's1', songId: 'song-bml', songTitle: 'Build My Life' },
    ])
    expect(h.refreshCount).toBe(1)
  })
})

describe('executePlan: clear', () => {
  it('optimistically clears items, fires clearSongFromSlot with restore title', async () => {
    const items = defaultPlan({
      1: { songId: 'song-bml', songTitle: 'Build My Life', title: 'Build My Life' },
    })
    const h = harness({ items })
    const plan = planFor(
      [{ slotIndex: 1, song: null }],
      items,
    )
    await executePlan(plan, h.deps, { source: 'user' })
    expect(h.items?.[0].songId).toBeNull()
    expect(h.items?.[0].title).toBe('Song 1')
    expect(h.pco.clearCalls).toEqual([
      { slotItemId: 's1', restoreTitle: 'Song 1' },
    ])
  })
})

describe('executePlan: swap', () => {
  it('renders one combined "swapped" message and fires paired commits (no clears)', async () => {
    const items = defaultPlan({
      1: { songId: 'song-A', songTitle: 'Song A' },
      2: { songId: 'song-B', songTitle: 'Song B' },
    })
    const h = harness({ items })
    const plan = planFor(
      [
        { slotIndex: 2, song: { id: 'song-A', title: 'Song A' } },
        { slotIndex: 1, song: { id: 'song-B', title: 'Song B' } },
      ],
      items,
    )
    await executePlan(plan, h.deps, { source: 'user' })
    const swapMessages = h.messages.filter((m) => /Swapped/.test(m))
    expect(swapMessages).toHaveLength(1)
    expect(h.pco.clearCalls).toHaveLength(0)
    expect(h.pco.placeCalls).toHaveLength(2)
  })

  it('handles PCO-direct swap (no candidate state — was the Phase 5 bug)', async () => {
    const items = defaultPlan({
      4: { songId: 'song-isa', songTitle: 'I Surrender All' },
      5: { songId: 'song-surr', songTitle: 'Surrender' },
    })
    const h = harness({ items })
    // The drag-ISA-onto-Surrender flow compiles to this:
    const plan = planFor(
      [
        { slotIndex: 4, song: { id: 'song-surr', title: 'Surrender' } },
        { slotIndex: 5, song: { id: 'song-isa', title: 'I Surrender All' } },
      ],
      items,
    )
    await executePlan(plan, h.deps, { source: 'user' })
    expect(h.pco.placeCalls).toHaveLength(2)
    expect(h.pco.clearCalls).toHaveLength(0)
    // Optimistic items reflect the swap.
    expect(h.items?.[3].songId).toBe('song-surr')
    expect(h.items?.[3].songTitle).toBe('Surrender')
    expect(h.items?.[4].songId).toBe('song-isa')
    expect(h.items?.[4].songTitle).toBe('I Surrender All')
  })
})

describe('executePlan: rollback', () => {
  it('restores pre-optimistic items when commit fails AND deferRefresh is set', async () => {
    const items = defaultPlan({
      1: { songId: 'song-orig', songTitle: 'Original' },
    })
    const h = harness({
      items,
      failNextPlace: new Error('PCO down'),
    })
    const plan = planFor(
      [{ slotIndex: 1, song: { id: 'song-new', title: 'New' } }],
      items,
    )
    await executePlan(plan, h.deps, { source: 'user', deferRefresh: true })
    // Items reverted to pre-optimistic.
    expect(h.items?.[0].songId).toBe('song-orig')
    expect(h.items?.[0].songTitle).toBe('Original')
    expect(h.messages.some((m) => m.match(/Commit failed/))).toBe(true)
  })
})

describe('synthesizeMessages: pure formatting', () => {
  it('user source uses arrow prefixes', () => {
    const items = defaultPlan()
    const plan = planFor(
      [{ slotIndex: 1, song: { id: 'song-bml', title: 'Build My Life' } }],
      items,
    )
    const lines = synthesizeMessages(plan, 'user')
    expect(lines[0]).toMatch(/^↗/)
  })

  it('ai source uses 🤖 prefix', () => {
    const items = defaultPlan()
    const plan = planFor(
      [{ slotIndex: 1, song: { id: 'song-bml', title: 'Build My Life' } }],
      items,
    )
    const lines = synthesizeMessages(plan, 'ai')
    expect(lines[0]).toMatch(/^🤖/)
  })

  it('mentions evicted song title in commit message when overwriting', () => {
    const items = defaultPlan({
      1: { songId: 'song-gog', songTitle: 'Goodness of God' },
    })
    const plan = planFor(
      [{ slotIndex: 1, song: { id: 'song-bml', title: 'Build My Life' } }],
      items,
    )
    expect(synthesizeMessages(plan, 'user')[0]).toMatch(
      /replacing "Goodness of God"/,
    )
  })
})
