import { describe, expect, it } from 'vitest'

import {
  HARD_BLOCK_DAYS,
  REDUCED_WEIGHT_DAYS,
  bucketRecentSongs,
  formatRecentlySung,
  type RecentSong,
} from './recentSongs'

const NOW = new Date('2026-08-02T00:00:00Z')

/** A song sung `days` before NOW. */
function sung(title: string, days: number, author: string | null = null): RecentSong {
  const d = new Date(NOW.getTime() - days * 86_400_000)
  return { title, author, lastSungAt: d.toISOString().slice(0, 10) }
}

describe('bucketRecentSongs', () => {
  it('splits on the two thresholds', () => {
    const { blocked, reduced } = bucketRecentSongs(
      [
        sung('Just Sung', 3),
        sung('Fortnight Edge', HARD_BLOCK_DAYS),
        sung('Middle', 30),
        sung('Six Week Edge', REDUCED_WEIGHT_DAYS),
        sung('Ancient', REDUCED_WEIGHT_DAYS + 1),
      ],
      NOW,
    )
    expect(blocked.map((s) => s.title)).toEqual(['Just Sung', 'Fortnight Edge'])
    expect(reduced.map((s) => s.title)).toEqual(['Middle', 'Six Week Edge'])
  })

  // Anything past the reduced-weight window carries no restriction, so
  // listing it would spend tokens telling the model a song is fine.
  it('drops songs older than the reduced-weight window entirely', () => {
    const { blocked, reduced } = bucketRecentSongs([sung('Ancient', 200)], NOW)
    expect(blocked).toEqual([])
    expect(reduced).toEqual([])
  })

  // A song sung twice belongs to the band for its most recent outing.
  // Bucketing on the older date would let something sung last Sunday
  // through as merely reduced-weight.
  it('buckets a repeated song by its most recent outing', () => {
    const { blocked, reduced } = bucketRecentSongs(
      [sung('Cornerstone', 120), sung('Cornerstone', 5)],
      NOW,
    )
    expect(blocked.map((s) => s.title)).toEqual(['Cornerstone'])
    expect(reduced).toEqual([])
  })

  it('dedupes on normalized title and author', () => {
    const { blocked } = bucketRecentSongs(
      [sung('The Lion and the Lamb', 5), sung('Lion and the Lamb', 6)],
      NOW,
    )
    expect(blocked).toHaveLength(1)
  })

  // Same title, different writers, is a different song — collapsing
  // them would silently block a song the congregation hasn't sung.
  it('keeps same-titled songs by different authors apart', () => {
    const { blocked } = bucketRecentSongs(
      [sung('Surrender', 5, 'Marc James'), sung('Surrender', 5, 'Lauren Daigle')],
      NOW,
    )
    expect(blocked).toHaveLength(2)
  })

  it('ignores an unparseable date rather than treating it as today', () => {
    const { blocked, reduced } = bucketRecentSongs(
      [{ title: 'Broken', author: null, lastSungAt: 'not-a-date' }],
      NOW,
    )
    expect(blocked).toEqual([])
    expect(reduced).toEqual([])
  })
})

describe('formatRecentlySung', () => {
  // The caller omits the section entirely on empty, so an empty string
  // has to mean "nothing to say" rather than a bare header.
  it('returns empty when nothing falls in either band', () => {
    expect(formatRecentlySung([], NOW)).toBe('')
    expect(formatRecentlySung([sung('Ancient', 300)], NOW)).toBe('')
  })

  // The thresholds live in the rendered labels rather than in the
  // system prompt, so the prompt only has to point at this block.
  it('labels each band with its own instruction', () => {
    const out = formatRecentlySung([sung('A', 3), sung('B', 30)], NOW)
    expect(out).toMatch(/last two weeks — do NOT propose/)
    expect(out).toMatch(/Two to six weeks ago — propose only if clearly the best fit/)
  })

  it('omits a band that has no songs', () => {
    const out = formatRecentlySung([sung('B', 30)], NOW)
    expect(out).not.toMatch(/do NOT propose/)
    expect(out).toMatch(/Two to six weeks ago/)
  })

  it('carries the author as a disambiguator', () => {
    const out = formatRecentlySung([sung('Surrender', 3, 'Marc James')], NOW)
    expect(out).toContain('Surrender (Marc James)')
  })
})
