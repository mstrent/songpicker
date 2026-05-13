import { describe, expect, it } from 'vitest'
import type { PlanItem } from '../api'
import {
  compileClearSlot,
  compileCommitToSlot,
  compileDropCandidateOnSlot,
  compileSlotToSlot,
} from './compile'

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

const items = [1, 2, 3, 4, 5].map((n) =>
  makeItem({ id: `s${n}`, sequence: n, title: `Song ${n}` }),
)

describe('compileDropCandidateOnSlot', () => {
  it('returns one assignment for any drop on a song slot', () => {
    expect(
      compileDropCandidateOnSlot(
        {
          song: { id: 'song-bml', title: 'Build My Life' },
          suggestion: { title: 'Build My Life' },
        },
        items[2],
        items,
      ),
    ).toEqual([
      {
        slotIndex: 3,
        song: { id: 'song-bml', title: 'Build My Life' },
      },
    ])
  })

  it('returns [] when candidate has no matched library song', () => {
    expect(
      compileDropCandidateOnSlot(
        { song: undefined, suggestion: { title: 'Untitled' } },
        items[0],
        items,
      ),
    ).toEqual([])
  })

  it('returns [] when item is not a song slot', () => {
    const rogue = makeItem({ id: 'header-1', itemType: 'header', title: 'Welcome' })
    expect(
      compileDropCandidateOnSlot(
        {
          song: { id: 'song-bml', title: 'Build My Life' },
          suggestion: { title: 'Build My Life' },
        },
        rogue,
        [...items, rogue],
      ),
    ).toEqual([])
  })
})

describe('compileClearSlot', () => {
  it('returns one null-song assignment', () => {
    expect(compileClearSlot(items[3], items)).toEqual([
      { slotIndex: 4, song: null },
    ])
  })
})

describe('compileCommitToSlot (popover)', () => {
  it('produces the same shape as a DnD drop', () => {
    expect(
      compileCommitToSlot(
        {
          song: { id: 'song-x', title: 'X' },
          suggestion: { title: 'X' },
        },
        items[1],
        items,
      ),
    ).toEqual([{ slotIndex: 2, song: { id: 'song-x', title: 'X' } }])
  })
})

describe('compileSlotToSlot', () => {
  it('source filled, target empty → move source song to target', () => {
    const slotsWithFilled = items.map((it, i) =>
      i === 0 ? { ...it, songId: 'song-a', songTitle: 'Song A' } : it,
    )
    const result = compileSlotToSlot(
      slotsWithFilled[0],
      slotsWithFilled[2],
      slotsWithFilled,
    )
    expect(result).toEqual([
      { slotIndex: 3, song: { id: 'song-a', title: 'Song A' } },
    ])
  })

  it('source empty, target filled → move target song to source', () => {
    const slotsWithFilled = items.map((it, i) =>
      i === 2 ? { ...it, songId: 'song-a', songTitle: 'Song A' } : it,
    )
    const result = compileSlotToSlot(
      slotsWithFilled[0],
      slotsWithFilled[2],
      slotsWithFilled,
    )
    expect(result).toEqual([
      { slotIndex: 1, song: { id: 'song-a', title: 'Song A' } },
    ])
  })

  it('both filled (with candidate-tracked songs) → swap', () => {
    const slotsWithFilled = items.map((it, i) => {
      if (i === 0) return { ...it, songId: 'song-a', songTitle: 'Song A' }
      if (i === 1) return { ...it, songId: 'song-b', songTitle: 'Song B' }
      return it
    })
    const result = compileSlotToSlot(
      slotsWithFilled[0],
      slotsWithFilled[1],
      slotsWithFilled,
    )
    expect(result).toEqual([
      { slotIndex: 1, song: { id: 'song-b', title: 'Song B' } },
      { slotIndex: 2, song: { id: 'song-a', title: 'Song A' } },
    ])
  })

  it('both filled (PCO-direct songs, no candidates needed) → swap', () => {
    // The pre-Phase-6 fallback case: now handled uniformly.
    const slotsWithFilled = items.map((it, i) => {
      if (i === 0) return { ...it, songId: 'pco-only-a', songTitle: 'PCO Only A' }
      if (i === 1) return { ...it, songId: 'pco-only-b', songTitle: 'PCO Only B' }
      return it
    })
    const result = compileSlotToSlot(
      slotsWithFilled[0],
      slotsWithFilled[1],
      slotsWithFilled,
    )
    expect(result).toEqual([
      { slotIndex: 1, song: { id: 'pco-only-b', title: 'PCO Only B' } },
      { slotIndex: 2, song: { id: 'pco-only-a', title: 'PCO Only A' } },
    ])
  })

  it('both empty → no-op', () => {
    expect(compileSlotToSlot(items[0], items[1], items)).toEqual([])
  })

  it('returns [] when dropping onto same slot', () => {
    expect(compileSlotToSlot(items[0], items[0], items)).toEqual([])
  })
})
