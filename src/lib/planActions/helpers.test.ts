import { describe, expect, it } from 'vitest'
import type { PlanItem } from '../api'
import {
  buildKnownSongTitles,
  detectSwapPairs,
  fallbackSlotTitle,
  findEvictionTarget,
  isTaintedTitle,
  placeholderForSlot,
  preTurnSlotPlaceholders,
  resolveRestoreTitle,
  type CandidateState,
} from './helpers'

// Test fixtures. Inline rather than imported so the test file is
// self-contained and obvious to read.
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
    suggestion: partial.suggestion ?? { title: 'untitled' },
    song: partial.song,
  }
}

describe('buildKnownSongTitles', () => {
  it('collects suggestion titles, matched song titles, and item songTitles, lowercased and trimmed', () => {
    const candidates: CandidateState[] = [
      makeCandidate({
        id: 'c1',
        suggestion: { title: '  How Great Is Our God  ' },
        song: { title: 'How Great Is Our God (Tomlin)' },
      }),
      makeCandidate({
        id: 'c2',
        suggestion: { title: 'Surrender' },
      }),
    ]
    const items: PlanItem[] = [
      makeItem({ id: 'i1', songTitle: 'Build My Life' }),
      makeItem({ id: 'i2', songTitle: null }),
    ]
    const known = buildKnownSongTitles(candidates, items)
    expect(known.has('how great is our god')).toBe(true)
    expect(known.has('how great is our god (tomlin)')).toBe(true)
    expect(known.has('surrender')).toBe(true)
    expect(known.has('build my life')).toBe(true)
    expect(known.has('')).toBe(false)
  })

  it('handles null/empty inputs', () => {
    const known = buildKnownSongTitles([], null)
    expect(known.size).toBe(0)
  })
})

describe('isTaintedTitle', () => {
  const known = new Set(['oceans (where feet may fail)', 'closing song'])

  it('returns true for a known title (case-insensitive, trimmed)', () => {
    expect(isTaintedTitle('Oceans (Where Feet May Fail)', known)).toBe(true)
    expect(isTaintedTitle('  oceans (where feet may fail)  ', known)).toBe(true)
  })

  it('returns false for unknown / empty / null inputs', () => {
    expect(isTaintedTitle('Song 1', known)).toBe(false)
    expect(isTaintedTitle('', known)).toBe(false)
    expect(isTaintedTitle(null, known)).toBe(false)
    expect(isTaintedTitle(undefined, known)).toBe(false)
    expect(isTaintedTitle('   ', known)).toBe(false)
  })

  it('catches the Closing-song taint scenario from the placeholder bug', () => {
    // Verifies the regression that motivated this helper: a candidate's
    // priorSlotTitle of "Closing song" is correctly identified as
    // tainted when "closing song" is in the known-titles set (because
    // some other slot's title currently equals it).
    expect(isTaintedTitle('Closing song', known)).toBe(true)
  })
})

describe('placeholderForSlot', () => {
  const fallback = (id: string) => `Song ${id}`

  it('returns the slot title when it differs from the song title', () => {
    const slot = makeItem({
      id: 'i1',
      title: 'Communion song',
      songTitle: 'Build My Life',
      songId: 'sX',
    })
    expect(placeholderForSlot(slot, {}, fallback)).toBe('Communion song')
  })

  it('falls back via persisted placeholder when title equals song title (PCO rewrote it)', () => {
    const slot = makeItem({
      id: 'i1',
      title: 'Build My Life',
      songTitle: 'Build My Life',
      songId: 'sX',
    })
    expect(placeholderForSlot(slot, { i1: 'Closing song' }, fallback)).toBe(
      'Closing song',
    )
  })

  it('falls back to position-based when title equals song title and no persisted placeholder', () => {
    const slot = makeItem({
      id: 'i1',
      title: 'Build My Life',
      songTitle: 'Build My Life',
      songId: 'sX',
    })
    expect(placeholderForSlot(slot, {}, fallback)).toBe('Song i1')
  })

  it('returns null when the slot has no title at all', () => {
    const slot = makeItem({ id: 'i1', title: '' })
    expect(placeholderForSlot(slot, { i1: 'Closing song' }, fallback)).toBeNull()
  })

  it('comparison is case-insensitive', () => {
    const slot = makeItem({
      id: 'i1',
      title: 'Build My Life',
      songTitle: 'BUILD MY LIFE',
      songId: 'sX',
    })
    expect(placeholderForSlot(slot, { i1: 'Song 4' }, fallback)).toBe('Song 4')
  })
})

describe('findEvictionTarget', () => {
  it('finds a different candidate committed to the target slot', () => {
    const candidates: CandidateState[] = [
      makeCandidate({
        id: 'c1',
        committedAt: 1,
        assignedSlotItemId: 'slot-a',
      }),
      makeCandidate({ id: 'c2' }),
    ]
    const evicted = findEvictionTarget('slot-a', candidates, 'c2')
    expect(evicted?.id).toBe('c1')
  })

  it('excludes the candidate being committed (no self-eviction)', () => {
    const candidates: CandidateState[] = [
      makeCandidate({
        id: 'c1',
        committedAt: 1,
        assignedSlotItemId: 'slot-a',
      }),
    ]
    expect(findEvictionTarget('slot-a', candidates, 'c1')).toBeNull()
  })

  it('returns null when target slot has no committed candidate', () => {
    const candidates: CandidateState[] = [
      makeCandidate({ id: 'c1', assignedSlotItemId: 'slot-b', committedAt: 1 }),
    ]
    expect(findEvictionTarget('slot-a', candidates, 'c2')).toBeNull()
  })

  it('ignores non-committed candidates assigned to the slot', () => {
    const candidates: CandidateState[] = [
      makeCandidate({
        id: 'c1',
        assignedSlotItemId: 'slot-a',
        committedAt: null,
      }),
    ]
    expect(findEvictionTarget('slot-a', candidates, 'c2')).toBeNull()
  })
})

describe('resolveRestoreTitle', () => {
  const fallback = (id: string) => `Song ${id}`

  it('prefers persisted placeholder over candidate prior over fallback', () => {
    const result = resolveRestoreTitle({
      slotItemId: 'i1',
      slotPlaceholders: { i1: 'Closing song' },
      candidatePriorSlotTitle: 'Communion song',
      knownSongTitles: new Set(),
      fallbackForSlot: fallback,
    })
    expect(result).toBe('Closing song')
  })

  it('falls back to candidate prior when no persisted placeholder', () => {
    const result = resolveRestoreTitle({
      slotItemId: 'i1',
      slotPlaceholders: {},
      candidatePriorSlotTitle: 'Communion song',
      knownSongTitles: new Set(),
      fallbackForSlot: fallback,
    })
    expect(result).toBe('Communion song')
  })

  it('rejects tainted candidate prior, falling through to position', () => {
    const result = resolveRestoreTitle({
      slotItemId: 'i1',
      slotPlaceholders: {},
      candidatePriorSlotTitle: 'Oceans (Where Feet May Fail)',
      knownSongTitles: new Set(['oceans (where feet may fail)']),
      fallbackForSlot: fallback,
    })
    expect(result).toBe('Song i1')
  })

  it('always returns a non-empty string (uses fallback)', () => {
    const result = resolveRestoreTitle({
      slotItemId: 'i1',
      slotPlaceholders: {},
      candidatePriorSlotTitle: null,
      knownSongTitles: new Set(),
      fallbackForSlot: fallback,
    })
    expect(result).toBe('Song i1')
  })

  it('opts out of taint detection when knownSongTitles is omitted', () => {
    // Caller intentionally bypasses taint check (e.g., commit-time
    // capture where we trust the prior since we're about to overwrite).
    const result = resolveRestoreTitle({
      slotItemId: 'i1',
      slotPlaceholders: {},
      candidatePriorSlotTitle: 'Some Song Name',
      fallbackForSlot: fallback,
    })
    expect(result).toBe('Some Song Name')
  })
})

describe('fallbackSlotTitle', () => {
  it('returns "Song N" using 1-based song-slot index', () => {
    const items: PlanItem[] = [
      makeItem({ id: 'a', itemType: 'song' }),
      makeItem({ id: 'b', itemType: 'header' }),
      makeItem({ id: 'c', itemType: 'song' }),
      makeItem({ id: 'd', itemType: 'song' }),
    ]
    expect(fallbackSlotTitle('a', items)).toBe('Song 1')
    expect(fallbackSlotTitle('c', items)).toBe('Song 2')
    expect(fallbackSlotTitle('d', items)).toBe('Song 3')
  })

  it('returns "Song" when item is not a known song slot', () => {
    expect(fallbackSlotTitle('missing', [])).toBe('Song')
    expect(fallbackSlotTitle('missing', null)).toBe('Song')
  })
})

describe('preTurnSlotPlaceholders', () => {
  it('captures non-tainted priorSlotTitles for committed candidates', () => {
    const candidates: CandidateState[] = [
      makeCandidate({
        id: 'c1',
        committedAt: 1,
        assignedSlotItemId: 'slot-a',
        priorSlotTitle: 'Closing song',
      }),
      makeCandidate({
        id: 'c2',
        committedAt: 2,
        assignedSlotItemId: 'slot-b',
        priorSlotTitle: 'Build My Life', // tainted (matches a known song)
      }),
      makeCandidate({
        id: 'c3',
        // not committed → skipped
        priorSlotTitle: 'Worship Set',
      }),
    ]
    const known = new Set(['build my life'])
    const map = preTurnSlotPlaceholders(candidates, known)
    expect(map.get('slot-a')).toBe('Closing song')
    expect(map.has('slot-b')).toBe(false)
    expect(map.size).toBe(1)
  })
})

describe('detectSwapPairs', () => {
  it('detects mutual swap (X at A, Y at B; assignments put X in B and Y in A)', () => {
    const candidates: CandidateState[] = [
      makeCandidate({
        id: 'X',
        committedAt: 1,
        assignedSlotItemId: 'slot-A',
      }),
      makeCandidate({
        id: 'Y',
        committedAt: 1,
        assignedSlotItemId: 'slot-B',
      }),
    ]
    const assignments = [
      { slotItemId: 'slot-B', candidateId: 'X' },
      { slotItemId: 'slot-A', candidateId: 'Y' },
    ]
    const pairs = detectSwapPairs(assignments, candidates)
    expect(pairs.get(0)).toBe(1)
    expect(pairs.get(1)).toBe(0)
  })

  it('does not pair a one-sided commit (X at A; assignment puts X in B with nothing going the other way)', () => {
    const candidates: CandidateState[] = [
      makeCandidate({
        id: 'X',
        committedAt: 1,
        assignedSlotItemId: 'slot-A',
      }),
    ]
    const assignments = [
      { slotItemId: 'slot-B', candidateId: 'X' },
      { slotItemId: 'slot-C', candidateId: 'Z' },
    ]
    const pairs = detectSwapPairs(assignments, candidates)
    expect(pairs.size).toBe(0)
  })

  it('skips clear assignments (candidateId null)', () => {
    const candidates: CandidateState[] = [
      makeCandidate({
        id: 'X',
        committedAt: 1,
        assignedSlotItemId: 'slot-A',
      }),
    ]
    const assignments = [
      { slotItemId: 'slot-A', candidateId: null },
      { slotItemId: 'slot-B', candidateId: 'X' },
    ]
    const pairs = detectSwapPairs(assignments, candidates)
    expect(pairs.size).toBe(0)
  })
})
