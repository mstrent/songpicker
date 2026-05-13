import { describe, expect, it } from 'vitest'
import type { PlanItem } from '../api'
import {
  detectSwapPairs,
  fallbackSlotTitle,
  placeholderForSlot,
  resolveRestoreTitle,
} from './helpers'

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

  it('falls back via persisted placeholder when title equals song title', () => {
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
})

describe('resolveRestoreTitle', () => {
  const fallback = (id: string) => `Song ${id}`

  it('prefers persisted placeholder', () => {
    const result = resolveRestoreTitle({
      slotItemId: 'i1',
      slotPlaceholders: { i1: 'Closing song' },
      fallbackForSlot: fallback,
    })
    expect(result).toBe('Closing song')
  })

  it('falls through to position-based fallback', () => {
    const result = resolveRestoreTitle({
      slotItemId: 'i1',
      slotPlaceholders: {},
      fallbackForSlot: fallback,
    })
    expect(result).toBe('Song i1')
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

describe('detectSwapPairs', () => {
  it('detects mutual swap from items.songId (PCO state)', () => {
    const items: PlanItem[] = [
      makeItem({ id: 'slot-A', songId: 'song-X', songTitle: 'X' }),
      makeItem({ id: 'slot-B', songId: 'song-Y', songTitle: 'Y' }),
    ]
    const assignments = [
      { slotItemId: 'slot-B', songId: 'song-X' },
      { slotItemId: 'slot-A', songId: 'song-Y' },
    ]
    const pairs = detectSwapPairs(assignments, items)
    expect(pairs.get(0)).toBe(1)
    expect(pairs.get(1)).toBe(0)
  })

  it('does not pair a one-sided commit', () => {
    const items: PlanItem[] = [
      makeItem({ id: 'slot-A', songId: 'song-X', songTitle: 'X' }),
    ]
    const assignments = [
      { slotItemId: 'slot-B', songId: 'song-X' },
      { slotItemId: 'slot-C', songId: 'song-Z' },
    ]
    const pairs = detectSwapPairs(assignments, items)
    expect(pairs.size).toBe(0)
  })

  it('skips clear assignments', () => {
    const items: PlanItem[] = [
      makeItem({ id: 'slot-A', songId: 'song-X', songTitle: 'X' }),
    ]
    const assignments = [
      { slotItemId: 'slot-A', songId: null },
      { slotItemId: 'slot-B', songId: 'song-X' },
    ]
    const pairs = detectSwapPairs(assignments, items)
    expect(pairs.size).toBe(0)
  })
})
