import { describe, expect, it } from 'vitest'
import type { PlanItem } from './api'
import type { CandidateMatch } from './useCandidatePool'
import { isCommittedSong, selectActiveCandidates } from './candidateView'

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
