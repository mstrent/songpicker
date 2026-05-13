import { describe, expect, it } from 'vitest'
import { applyDecisionChange, type ApplyDecisionDeps } from './decisions'
import type { CandidateState } from './helpers'

function makeCandidate(
  partial: Partial<CandidateState> & Pick<CandidateState, 'id'>,
): CandidateState {
  return {
    id: partial.id,
    decision: partial.decision ?? 'pending',
    suggestion: partial.suggestion ?? { title: 'Untitled' },
    song: partial.song,
  }
}

interface Harness {
  candidates: CandidateState[]
  messages: string[]
  rejectsLanded: number[]
  deps: ApplyDecisionDeps
}

function harness(
  initial: CandidateState[],
  committedSongIds: Set<string> = new Set(),
): Harness {
  const h: Harness = {
    candidates: [...initial],
    messages: [],
    rejectsLanded: [],
    deps: undefined as unknown as ApplyDecisionDeps,
  }
  h.deps = {
    get candidates() {
      return h.candidates
    },
    setCandidates: (update) => {
      h.candidates = update(h.candidates)
    },
    appendSystemMessage: (msg) => h.messages.push(msg),
    committedSongIds,
    onRejectsLanded: (n) => h.rejectsLanded.push(n),
  }
  return h
}

describe('applyDecisionChange: reject', () => {
  it('flips a pending candidate to rejected; emits message; bumps reject signal', () => {
    const c = makeCandidate({
      id: 'c1',
      suggestion: { title: 'Surrender' },
      song: { id: 'song-x', title: 'Surrender' },
    })
    const h = harness([c])
    const result = applyDecisionChange(
      { ids: ['c1'], decision: 'reject' },
      'user',
      h.deps,
    )
    expect(result.changedIds).toEqual(['c1'])
    expect(h.candidates[0].decision).toBe('reject')
    expect(h.messages).toContain('✗ Rejected: Surrender')
    expect(h.rejectsLanded).toEqual([1])
  })

  it('skips candidates whose song is currently in the plan (committed)', () => {
    const c = makeCandidate({
      id: 'c1',
      suggestion: { title: 'Surrender' },
      song: { id: 'song-x', title: 'Surrender' },
    })
    const h = harness([c], new Set(['song-x']))
    const result = applyDecisionChange(
      { ids: ['c1'], decision: 'reject' },
      'user',
      h.deps,
    )
    expect(result.changedIds).toEqual([])
    expect(h.candidates[0].decision).toBe('pending')
    expect(h.messages).toEqual([])
    expect(h.rejectsLanded).toEqual([])
  })

  it('skips already-rejected candidates', () => {
    const c = makeCandidate({
      id: 'c1',
      decision: 'reject',
      suggestion: { title: 'Surrender' },
    })
    const h = harness([c])
    const result = applyDecisionChange(
      { ids: ['c1'], decision: 'reject' },
      'user',
      h.deps,
    )
    expect(result.changedIds).toEqual([])
  })

  it('AI source uses 🤖 prefix and a single message for the cluster', () => {
    const c1 = makeCandidate({ id: 'c1', suggestion: { title: 'A' } })
    const c2 = makeCandidate({ id: 'c2', suggestion: { title: 'B' } })
    const h = harness([c1, c2])
    applyDecisionChange(
      { ids: ['c1', 'c2'], decision: 'reject' },
      'ai',
      h.deps,
    )
    expect(h.messages).toEqual(['🤖 AI rejected A, B'])
  })

  it('UI source emits one message per rejected candidate', () => {
    const c1 = makeCandidate({ id: 'c1', suggestion: { title: 'A' } })
    const c2 = makeCandidate({ id: 'c2', suggestion: { title: 'B' } })
    const h = harness([c1, c2])
    applyDecisionChange(
      { ids: ['c1', 'c2'], decision: 'reject' },
      'user',
      h.deps,
    )
    expect(h.messages).toEqual(['✗ Rejected: A', '✗ Rejected: B'])
  })
})

describe('applyDecisionChange: unreject', () => {
  it('flips rejected back to pending', () => {
    const c = makeCandidate({
      id: 'c1',
      decision: 'reject',
      suggestion: { title: 'Surrender' },
    })
    const h = harness([c])
    const result = applyDecisionChange(
      { ids: ['c1'], decision: 'pending' },
      'user',
      h.deps,
    )
    expect(result.changedIds).toEqual(['c1'])
    expect(h.candidates[0].decision).toBe('pending')
    expect(h.messages).toContain('↩ Unrejected: Surrender')
  })

  it('AI source uses 🤖 prefix with cluster message', () => {
    const c1 = makeCandidate({
      id: 'c1',
      decision: 'reject',
      suggestion: { title: 'A' },
    })
    const c2 = makeCandidate({
      id: 'c2',
      decision: 'reject',
      suggestion: { title: 'B' },
    })
    const h = harness([c1, c2])
    applyDecisionChange(
      { ids: ['c1', 'c2'], decision: 'pending' },
      'ai',
      h.deps,
    )
    expect(h.messages).toEqual(['🤖 AI restored A, B to the candidate pool'])
  })
})
