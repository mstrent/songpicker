import { describe, expect, it } from 'vitest'
import type { PlanItem } from '../api'
import {
  compileClearSlot,
  compileCommitToSlot,
  compileDropCandidateOnSlot,
  compileSlotToSlot,
} from './compile'
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

const items = [1, 2, 3, 4, 5].map((n) =>
  makeItem({ id: `s${n}`, sequence: n, title: `Song ${n}` }),
)

describe('compileDropCandidateOnSlot', () => {
  it('returns one assignment for any drop on a song slot', () => {
    expect(compileDropCandidateOnSlot('c1', items[2], items)).toEqual([
      { slotIndex: 3, candidateId: 'c1' },
    ])
  })

  it('returns empty when item is not a song slot', () => {
    const rogue = makeItem({ id: 'header-1', itemType: 'header', title: 'Welcome' })
    expect(compileDropCandidateOnSlot('c1', rogue, [...items, rogue])).toEqual([])
  })
})

describe('compileClearSlot', () => {
  it('returns one null assignment', () => {
    expect(compileClearSlot(items[3], items)).toEqual([
      { slotIndex: 4, candidateId: null },
    ])
  })
})

describe('compileCommitToSlot (popover)', () => {
  it('produces the same shape as a DnD drop', () => {
    expect(compileCommitToSlot('c1', items[1], items)).toEqual([
      { slotIndex: 2, candidateId: 'c1' },
    ])
  })
})

describe('compileSlotToSlot', () => {
  it('source filled, target empty → move source song to target', () => {
    const slotsWithFilled = items.map((it, i) =>
      i === 0
        ? { ...it, songId: 'song-a', songTitle: 'Song A' }
        : it,
    )
    const cand = makeCandidate({
      id: 'A',
      committedAt: 1,
      assignedSlotItemId: 's1',
    })
    const result = compileSlotToSlot(
      slotsWithFilled[0], // source filled
      slotsWithFilled[2], // target empty
      [cand],
      slotsWithFilled,
    )
    expect(result).toEqual([{ slotIndex: 3, candidateId: 'A' }])
  })

  it('source empty, target filled → move target song to source', () => {
    const slotsWithFilled = items.map((it, i) =>
      i === 2
        ? { ...it, songId: 'song-a', songTitle: 'Song A' }
        : it,
    )
    const cand = makeCandidate({
      id: 'A',
      committedAt: 1,
      assignedSlotItemId: 's3',
    })
    const result = compileSlotToSlot(
      slotsWithFilled[0], // source empty
      slotsWithFilled[2], // target filled
      [cand],
      slotsWithFilled,
    )
    expect(result).toEqual([{ slotIndex: 1, candidateId: 'A' }])
  })

  it('both filled → swap (two assignments)', () => {
    const slotsWithFilled = items.map((it, i) => {
      if (i === 0) return { ...it, songId: 'song-a', songTitle: 'Song A' }
      if (i === 1) return { ...it, songId: 'song-b', songTitle: 'Song B' }
      return it
    })
    const a = makeCandidate({
      id: 'A',
      committedAt: 1,
      assignedSlotItemId: 's1',
    })
    const b = makeCandidate({
      id: 'B',
      committedAt: 1,
      assignedSlotItemId: 's2',
    })
    const result = compileSlotToSlot(
      slotsWithFilled[0],
      slotsWithFilled[1],
      [a, b],
      slotsWithFilled,
    )
    expect(result).toEqual([
      { slotIndex: 1, candidateId: 'B' },
      { slotIndex: 2, candidateId: 'A' },
    ])
  })

  it('both empty → no-op', () => {
    expect(compileSlotToSlot(items[0], items[1], [], items)).toEqual([])
  })

  it('returns [] when source slot has a PCO-direct song with no candidate (caller falls back)', () => {
    const slotsWithFilled = items.map((it, i) =>
      i === 0 ? { ...it, songId: 'pco-only', songTitle: 'PCO Only' } : it,
    )
    expect(
      compileSlotToSlot(slotsWithFilled[0], slotsWithFilled[2], [], slotsWithFilled),
    ).toEqual([])
  })

  it('returns [] when dropping onto same slot', () => {
    expect(compileSlotToSlot(items[0], items[0], [], items)).toEqual([])
  })
})
