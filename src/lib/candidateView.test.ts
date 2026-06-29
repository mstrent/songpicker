import { describe, expect, it } from 'vitest'
import type { PlanItem } from './api'
import type { CandidateMatch } from './useCandidatePool'
import {
  isCommittedSong,
  reorderCandidates,
  selectActiveCandidates,
} from './candidateView'

function makeItem(
  partial: Partial<PlanItem> & Pick<PlanItem, 'id'>,
): PlanItem {
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
  partial: Partial<CandidateMatch> & Pick<CandidateMatch, 'id'>,
): CandidateMatch {
  return {
    id: partial.id,
    suggestion: partial.suggestion ?? { title: `Song ${partial.id}` },
    matchStatus: partial.matchStatus ?? 'matched',
    song: partial.song,
    error: partial.error,
    decision: partial.decision ?? 'pending',
    addedAt: partial.addedAt ?? 0,
    enrichmentPending: partial.enrichmentPending,
  }
}

describe('isCommittedSong', () => {
  it('is true when the candidate song id matches a linked item', () => {
    const c = makeCandidate({ id: 'a', song: { id: 's1' } as never })
    const items = [makeItem({ id: 'i1', songId: 's1' })]
    expect(isCommittedSong(c, items)).toBe(true)
  })

  it('is false when no item is linked to the candidate song', () => {
    const c = makeCandidate({ id: 'a', song: { id: 's1' } as never })
    const items = [makeItem({ id: 'i1', songId: 's2' })]
    expect(isCommittedSong(c, items)).toBe(false)
  })

  it('is false for a candidate with no matched song', () => {
    const c = makeCandidate({ id: 'a', matchStatus: 'unmatched', song: undefined })
    const items = [makeItem({ id: 'i1', songId: 's1' })]
    expect(isCommittedSong(c, items)).toBe(false)
  })
})

describe('selectActiveCandidates', () => {
  it('excludes rejected candidates', () => {
    const candidates = [
      makeCandidate({ id: 'a', decision: 'pending' }),
      makeCandidate({ id: 'b', decision: 'reject' }),
    ]
    const active = selectActiveCandidates(candidates, [])
    expect(active.map((c) => c.id)).toEqual(['a'])
  })

  it('excludes candidates committed to a slot', () => {
    const candidates = [
      makeCandidate({ id: 'a', song: { id: 's1' } as never }),
      makeCandidate({ id: 'b', song: { id: 's2' } as never }),
    ]
    const items = [makeItem({ id: 'i1', songId: 's1' })]
    const active = selectActiveCandidates(candidates, items)
    expect(active.map((c) => c.id)).toEqual(['b'])
  })

  it('keeps pending, uncommitted candidates', () => {
    const candidates = [makeCandidate({ id: 'a', song: { id: 's1' } as never })]
    const active = selectActiveCandidates(candidates, [])
    expect(active.map((c) => c.id)).toEqual(['a'])
  })

  it('re-includes a candidate once its slot is cleared (round-trip)', () => {
    const candidates = [makeCandidate({ id: 'a', song: { id: 's1' } as never })]
    // committed: linked to a slot -> excluded
    expect(
      selectActiveCandidates(candidates, [
        makeItem({ id: 'i1', songId: 's1' }),
      ]).map((c) => c.id),
    ).toEqual([])
    // slot cleared (songId null) -> the candidate comes back
    expect(
      selectActiveCandidates(candidates, [
        makeItem({ id: 'i1', songId: null }),
      ]).map((c) => c.id),
    ).toEqual(['a'])
  })
})

describe('reorderCandidates', () => {
  const ids = (list: CandidateMatch[]) => list.map((c) => c.id)
  const make = (...xs: string[]) => xs.map((id) => makeCandidate({ id }))

  it('moves the dragged candidate to immediately before the target', () => {
    const list = make('a', 'b', 'c', 'd')
    expect(ids(reorderCandidates(list, 'd', 'b'))).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves a candidate downward (target below it)', () => {
    const list = make('a', 'b', 'c', 'd')
    expect(ids(reorderCandidates(list, 'a', 'c'))).toEqual(['b', 'a', 'c', 'd'])
  })

  it('moves to the end when beforeId is null', () => {
    const list = make('a', 'b', 'c')
    expect(ids(reorderCandidates(list, 'a', null))).toEqual(['b', 'c', 'a'])
  })

  it('preserves interleaved non-active entries by id order', () => {
    // 'r' is a rejected card rendered elsewhere; reordering the active
    // cards around it must not lose it.
    const list = [
      makeCandidate({ id: 'a' }),
      makeCandidate({ id: 'r', decision: 'reject' }),
      makeCandidate({ id: 'b' }),
      makeCandidate({ id: 'c' }),
    ]
    // drag c to before b -> active order a, c, b; r still present
    const out = reorderCandidates(list, 'c', 'b')
    expect(ids(out)).toEqual(['a', 'r', 'c', 'b'])
  })

  it('is a no-op when the dragged id is not found', () => {
    const list = make('a', 'b', 'c')
    expect(ids(reorderCandidates(list, 'z', 'a'))).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op when beforeId equals the dragged id', () => {
    const list = make('a', 'b', 'c')
    expect(ids(reorderCandidates(list, 'b', 'b'))).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op when beforeId is not found', () => {
    const list = make('a', 'b', 'c')
    expect(ids(reorderCandidates(list, 'a', 'z'))).toEqual(['a', 'b', 'c'])
  })

  it('returns a new array (does not mutate the input)', () => {
    const list = make('a', 'b', 'c')
    const out = reorderCandidates(list, 'c', 'a')
    expect(out).not.toBe(list)
    expect(ids(list)).toEqual(['a', 'b', 'c'])
  })
})
