import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanItem } from '../api'
import { executePlan, type ExecutorDeps, type PcoCallables } from './executor'
import { synthesizeMessages } from './messages'
import { resolvePlan, type Plan, type ResolverState } from './resolver'
import type { CandidateState } from './helpers'

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

function makeCandidate(
  partial: Partial<CandidateState> & Pick<CandidateState, 'id'>,
): CandidateState {
  return {
    id: partial.id,
    decision: partial.decision ?? 'pending',
    committedAt: partial.committedAt ?? null,
    assignedSlotItemId: partial.assignedSlotItemId ?? null,
    priorSlotTitle: partial.priorSlotTitle ?? null,
    suggestion: partial.suggestion ?? { title: 'Untitled' },
    song: partial.song,
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
  candidates: CandidateState[]
  messages: string[]
  refreshCount: number
  pco: {
    placeCalls: Array<{ slotItemId: string; songId: string; songTitle?: string }>
    clearCalls: Array<{ slotItemId: string; restoreTitle?: string }>
  }
  deps: ExecutorDeps
}

function harness(initial: {
  candidates: CandidateState[]
  /** When set, the next placeSongInSlot call rejects with this error
   *  to test the rollback path. One-shot per call. */
  failNextPlace?: Error
}): Harness {
  const h: Harness = {
    candidates: [...initial.candidates],
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
    setCandidates: (update) => {
      h.candidates = update(h.candidates)
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
  assignments: { slotIndex: number; candidateId: string | null }[],
  candidates: CandidateState[],
  items = defaultPlan(),
  slotPlaceholders: Record<string, string> = {},
): Plan {
  const state: ResolverState = { items, candidates, slotPlaceholders }
  return resolvePlan(assignments, state)
}

describe('executePlan: empty', () => {
  it('returns immediately on empty plan, no PCO, no refresh', async () => {
    const h = harness({ candidates: [] })
    const plan = planFor([], [])
    const result = await executePlan(plan, h.deps)
    expect(result.pcoWritesFired).toBe(false)
    expect(h.pco.placeCalls).toEqual([])
    expect(h.pco.clearCalls).toEqual([])
    expect(h.refreshCount).toBe(0)
    expect(h.messages).toEqual([])
  })

  it('surfaces warnings as ⚠ messages even with no resolved entries', async () => {
    const h = harness({ candidates: [] })
    const plan = planFor([{ slotIndex: 99, candidateId: null }], [])
    await executePlan(plan, h.deps)
    expect(h.messages).toHaveLength(1)
    expect(h.messages[0]).toMatch(/^⚠/)
  })
})

describe('executePlan: fresh commit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T12:00:00Z'))
  })

  it('flips candidate to committed, fires placeSongInSlot, refreshes', async () => {
    const cand = makeCandidate({
      id: 'c1',
      suggestion: { title: 'Build My Life' },
      song: { id: 'song-bml', title: 'Build My Life' },
    })
    const h = harness({ candidates: [cand] })
    const plan = planFor([{ slotIndex: 1, candidateId: 'c1' }], [cand])
    const result = await executePlan(plan, h.deps, { source: 'user' })
    expect(result.pcoWritesFired).toBe(true)
    expect(h.candidates[0].committedAt).not.toBeNull()
    expect(h.candidates[0].assignedSlotItemId).toBe('s1')
    expect(h.pco.placeCalls).toEqual([
      { slotItemId: 's1', songId: 'song-bml', songTitle: 'Build My Life' },
    ])
    expect(h.pco.clearCalls).toEqual([])
    expect(h.refreshCount).toBe(1)
    expect(h.messages.some((m) => m.includes('Committed "Build My Life"'))).toBe(true)
  })

  it('skips refresh when deferRefresh is set', async () => {
    const cand = makeCandidate({
      id: 'c1',
      suggestion: { title: 'Build My Life' },
      song: { id: 'song-bml', title: 'Build My Life' },
    })
    const h = harness({ candidates: [cand] })
    const plan = planFor([{ slotIndex: 1, candidateId: 'c1' }], [cand])
    await executePlan(plan, h.deps, { deferRefresh: true })
    expect(h.refreshCount).toBe(0)
  })
})

describe('executePlan: clear', () => {
  it('resets the occupant, fires clearSongFromSlot with restore title', async () => {
    const occupant = makeCandidate({
      id: 'c1',
      committedAt: 1,
      assignedSlotItemId: 's1',
      suggestion: { title: 'Build My Life' },
      song: { id: 'song-bml', title: 'Build My Life' },
    })
    const h = harness({ candidates: [occupant] })
    const items = defaultPlan({ 1: { songId: 'song-bml', songTitle: 'Build My Life' } })
    const plan = planFor([{ slotIndex: 1, candidateId: null }], [occupant], items)
    await executePlan(plan, h.deps, { source: 'user' })
    expect(h.candidates[0].committedAt).toBeNull()
    expect(h.candidates[0].assignedSlotItemId).toBeNull()
    expect(h.pco.clearCalls).toEqual([
      { slotItemId: 's1', restoreTitle: 'Song 1' },
    ])
  })
})

describe('executePlan: overwrite (eviction)', () => {
  it('evicts the existing committed candidate and commits the new one', async () => {
    const existing = makeCandidate({
      id: 'c-existing',
      committedAt: 1,
      assignedSlotItemId: 's1',
      suggestion: { title: 'Goodness of God' },
      song: { id: 'song-gog', title: 'Goodness of God' },
    })
    const newCand = makeCandidate({
      id: 'c-new',
      suggestion: { title: 'Build My Life' },
      song: { id: 'song-bml', title: 'Build My Life' },
    })
    const h = harness({ candidates: [existing, newCand] })
    const items = defaultPlan({ 1: { songId: 'song-gog', songTitle: 'Goodness of God' } })
    const plan = planFor(
      [{ slotIndex: 1, candidateId: 'c-new' }],
      [existing, newCand],
      items,
    )
    await executePlan(plan, h.deps, { source: 'user' })
    const evicted = h.candidates.find((c) => c.id === 'c-existing')
    expect(evicted?.committedAt).toBeNull()
    expect(evicted?.assignedSlotItemId).toBeNull()
    const newC = h.candidates.find((c) => c.id === 'c-new')
    expect(newC?.committedAt).not.toBeNull()
    expect(newC?.assignedSlotItemId).toBe('s1')
    expect(h.messages.some((m) => m.includes('replacing "Goodness of God"'))).toBe(true)
  })
})

describe('executePlan: rollback', () => {
  it('restores both new and evicted candidate state when PCO commit fails', async () => {
    const existing = makeCandidate({
      id: 'c-existing',
      committedAt: 100,
      assignedSlotItemId: 's1',
      priorSlotTitle: 'Song 1',
      suggestion: { title: 'Goodness of God' },
      song: { id: 'song-gog', title: 'Goodness of God' },
    })
    const newCand = makeCandidate({
      id: 'c-new',
      suggestion: { title: 'Build My Life' },
      song: { id: 'song-bml', title: 'Build My Life' },
    })
    const h = harness({
      candidates: [existing, newCand],
      failNextPlace: new Error('PCO down'),
    })
    const items = defaultPlan({ 1: { songId: 'song-gog', songTitle: 'Goodness of God' } })
    const plan = planFor(
      [{ slotIndex: 1, candidateId: 'c-new' }],
      [existing, newCand],
      items,
    )
    await executePlan(plan, h.deps, { source: 'user' })
    // After rollback, the new candidate is back to uncommitted and
    // the existing one is back to committed at slot 1.
    const newAfter = h.candidates.find((c) => c.id === 'c-new')
    expect(newAfter?.committedAt).toBeNull()
    expect(newAfter?.assignedSlotItemId).toBeNull()
    const existingAfter = h.candidates.find((c) => c.id === 'c-existing')
    expect(existingAfter?.committedAt).toBe(100)
    expect(existingAfter?.assignedSlotItemId).toBe('s1')
    expect(h.messages.some((m) => m.match(/Commit failed/))).toBe(true)
  })
})

describe('executePlan: swap', () => {
  it('renders one combined "swapped" message, not two commits', async () => {
    const a = makeCandidate({
      id: 'A',
      committedAt: 1,
      assignedSlotItemId: 's1',
      suggestion: { title: 'Song A' },
      song: { id: 'song-a', title: 'Song A' },
    })
    const b = makeCandidate({
      id: 'B',
      committedAt: 1,
      assignedSlotItemId: 's2',
      suggestion: { title: 'Song B' },
      song: { id: 'song-b', title: 'Song B' },
    })
    const h = harness({ candidates: [a, b] })
    const items = defaultPlan({
      1: { songId: 'song-a', songTitle: 'Song A' },
      2: { songId: 'song-b', songTitle: 'Song B' },
    })
    const plan = planFor(
      [
        { slotIndex: 2, candidateId: 'A' },
        { slotIndex: 1, candidateId: 'B' },
      ],
      [a, b],
      items,
    )
    await executePlan(plan, h.deps, { source: 'user' })
    const swapMessages = h.messages.filter((m) => /Swapped/.test(m))
    expect(swapMessages).toHaveLength(1)
    expect(swapMessages[0]).toMatch(/Song A/)
    expect(swapMessages[0]).toMatch(/Song B/)
  })

  it('drops clears for slots that are also commit targets (commits-overwrite-clears)', async () => {
    // Same swap as above. plannedClears would have entries for s1
    // and s2 (move sources), but plannedCommits also targets s1 and
    // s2, so both clears should be deduped away. Net: 0 clear calls,
    // 2 commit calls.
    const a = makeCandidate({
      id: 'A',
      committedAt: 1,
      assignedSlotItemId: 's1',
      suggestion: { title: 'Song A' },
      song: { id: 'song-a', title: 'Song A' },
    })
    const b = makeCandidate({
      id: 'B',
      committedAt: 1,
      assignedSlotItemId: 's2',
      suggestion: { title: 'Song B' },
      song: { id: 'song-b', title: 'Song B' },
    })
    const h = harness({ candidates: [a, b] })
    const items = defaultPlan({
      1: { songId: 'song-a', songTitle: 'Song A' },
      2: { songId: 'song-b', songTitle: 'Song B' },
    })
    const plan = planFor(
      [
        { slotIndex: 2, candidateId: 'A' },
        { slotIndex: 1, candidateId: 'B' },
      ],
      [a, b],
      items,
    )
    await executePlan(plan, h.deps)
    expect(h.pco.clearCalls).toHaveLength(0)
    expect(h.pco.placeCalls).toHaveLength(2)
  })
})

describe('synthesizeMessages: pure formatting', () => {
  it('user source uses arrow prefixes', () => {
    const cand = makeCandidate({
      id: 'c1',
      suggestion: { title: 'Build My Life' },
      song: { id: 'song-bml', title: 'Build My Life' },
    })
    const plan = planFor([{ slotIndex: 1, candidateId: 'c1' }], [cand])
    const lines = synthesizeMessages(plan, 'user')
    expect(lines[0]).toMatch(/^↗/)
  })

  it('ai source uses 🤖 prefix', () => {
    const cand = makeCandidate({
      id: 'c1',
      suggestion: { title: 'Build My Life' },
      song: { id: 'song-bml', title: 'Build My Life' },
    })
    const plan = planFor([{ slotIndex: 1, candidateId: 'c1' }], [cand])
    const lines = synthesizeMessages(plan, 'ai')
    expect(lines[0]).toMatch(/^🤖/)
  })

  it('mentions evicted song in commit message when overwriting', () => {
    const existing = makeCandidate({
      id: 'c-existing',
      committedAt: 1,
      assignedSlotItemId: 's1',
      suggestion: { title: 'Goodness of God' },
      song: { id: 'song-gog', title: 'Goodness of God' },
    })
    const newCand = makeCandidate({
      id: 'c-new',
      suggestion: { title: 'Build My Life' },
      song: { id: 'song-bml', title: 'Build My Life' },
    })
    const items = defaultPlan({ 1: { songId: 'song-gog', songTitle: 'Goodness of God' } })
    const plan = planFor(
      [{ slotIndex: 1, candidateId: 'c-new' }],
      [existing, newCand],
      items,
    )
    expect(synthesizeMessages(plan, 'user')[0]).toMatch(/replacing "Goodness of God"/)
  })
})
