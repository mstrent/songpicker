import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ROTATION_WINDOWS,
  MAX_REDUCED_WEIGHT_DAYS,
  bucketRecentSongs,
  formatRecentlySung,
  formatScheduledAhead,
  parseRotationWindows,
  type RecentSong,
  type UpcomingSong,
} from './recentSongs'

const HARD_BLOCK_DAYS = DEFAULT_ROTATION_WINDOWS.hardBlockDays
const REDUCED_WEIGHT_DAYS = DEFAULT_ROTATION_WINDOWS.reducedWeightDays

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
    expect(out).toMatch(
      new RegExp(`last ${HARD_BLOCK_DAYS} days — do NOT propose`),
    )
    expect(out).toMatch(
      new RegExp(
        `Sung ${HARD_BLOCK_DAYS + 1}-${REDUCED_WEIGHT_DAYS} days ago — propose only if clearly the best fit`,
      ),
    )
  })

  it('omits a band that has no songs', () => {
    const out = formatRecentlySung([sung('B', 30)], NOW)
    expect(out).not.toMatch(/do NOT propose/)
    expect(out).toMatch(/propose only if clearly the best fit/)
  })

  it('carries the author as a disambiguator', () => {
    const out = formatRecentlySung([sung('Surrender', 3, 'Marc James')], NOW)
    expect(out).toContain('Surrender (Marc James)')
  })

  // The labels are generated from the configured windows rather than
  // written as prose, so an admin retuning them can't leave the block
  // telling the model "two weeks" while the cutoff is thirty days.
  it('labels the bands from the configured windows', () => {
    const out = formatRecentlySung([sung('A', 3), sung('B', 20)], NOW, {
      hardBlockDays: 7,
      reducedWeightDays: 30,
      lookAheadDays: 0,
    })
    expect(out).toContain('within the last 7 days')
    expect(out).toContain('Sung 8-30 days ago')
  })

  it('rebands the same songs when the windows change', () => {
    const songs = [sung('Edge', 20)]
    expect(formatRecentlySung(songs, NOW, {
      hardBlockDays: 30,
      reducedWeightDays: 60,
      lookAheadDays: 0,
    })).toMatch(/do NOT propose/)
    expect(formatRecentlySung(songs, NOW, {
      hardBlockDays: 7,
      reducedWeightDays: 30,
      lookAheadDays: 0,
    })).toMatch(/propose only if clearly the best fit/)
  })
})

/** A song booked `days` after NOW, in plan `planId`. */
function booked(
  title: string,
  days: number,
  planId = 'other-plan',
  author: string | null = null,
): UpcomingSong {
  const d = new Date(NOW.getTime() + days * 86_400_000)
  return { title, author, scheduledFor: d.toISOString().slice(0, 10), planId }
}

const WINDOWS_60 = { ...DEFAULT_ROTATION_WINDOWS, lookAheadDays: 60 }

describe('formatScheduledAhead', () => {
  // The plan being edited is full of songs the user just committed.
  // Without this filter they'd come back as "already scheduled ahead"
  // — arguing against the very picks the user has made, and
  // duplicating what "Already in plan" already says.
  it('excludes the plan currently being edited', () => {
    const out = formatScheduledAhead(
      [booked('Mine', 0, 'this-plan'), booked('Theirs', 7, 'next-plan')],
      'this-plan',
      NOW,
      WINDOWS_60,
    )
    expect(out).not.toContain('Mine')
    expect(out).toContain('Theirs')
  })

  it('drops bookings past the look-ahead window', () => {
    const out = formatScheduledAhead(
      [booked('Soon', 10), booked('Far', 90)],
      undefined,
      NOW,
      WINDOWS_60,
    )
    expect(out).toContain('Soon')
    expect(out).not.toContain('Far')
  })

  // Past-dated entries would mean a stale future list; they belong to
  // the recency path, not this one.
  it('ignores anything already in the past', () => {
    expect(
      formatScheduledAhead([booked('Yesterday', -1)], undefined, NOW, WINDOWS_60),
    ).toBe('')
  })

  // Proximity is the whole signal: a song booked next week conflicts
  // far more than one booked in seven, so the model needs the dates.
  it('groups by service date in chronological order', () => {
    const out = formatScheduledAhead(
      [booked('Later', 21), booked('Sooner', 7), booked('AlsoSooner', 7)],
      undefined,
      NOW,
      WINDOWS_60,
    )
    const soonerAt = out.indexOf('Sooner')
    const laterAt = out.indexOf('Later')
    expect(soonerAt).toBeGreaterThan(-1)
    expect(laterAt).toBeGreaterThan(soonerAt)
    expect(out).toMatch(/Sooner, AlsoSooner|AlsoSooner, Sooner/)
  })

  it('is silent when the look-ahead is turned off', () => {
    expect(
      formatScheduledAhead([booked('Soon', 7)], undefined, NOW, {
        ...DEFAULT_ROTATION_WINDOWS,
        lookAheadDays: 0,
      }),
    ).toBe('')
  })

  // It's a bias, not a block — future plans get rearranged, so
  // language that reads as prohibition would be wrong.
  it('frames the list as a bias rather than a prohibition', () => {
    const out = formatScheduledAhead([booked('Soon', 7)], undefined, NOW, WINDOWS_60)
    expect(out).not.toMatch(/do NOT/)
    expect(out).toMatch(/clearly beat/)
  })
})

describe('parseRotationWindows', () => {
  // Configs written before the look-ahead existed are still valid;
  // absence reads as the default rather than a rejection.
  it('defaults a missing lookAheadDays instead of rejecting', () => {
    expect(
      parseRotationWindows({ hardBlockDays: 7, reducedWeightDays: 30 }),
    ).toEqual({
      hardBlockDays: 7,
      reducedWeightDays: 30,
      lookAheadDays: DEFAULT_ROTATION_WINDOWS.lookAheadDays,
    })
  })

  // Zero is meaningful — it turns the look-ahead off — so it must not
  // be lumped in with the invalid values.
  it('accepts zero look-ahead but rejects negative', () => {
    expect(
      parseRotationWindows({
        hardBlockDays: 7,
        reducedWeightDays: 30,
        lookAheadDays: 0,
      }),
    ).not.toBeNull()
    expect(
      parseRotationWindows({
        hardBlockDays: 7,
        reducedWeightDays: 30,
        lookAheadDays: -1,
      }),
    ).toBeNull()
  })

  it('accepts a well-formed pair', () => {
    expect(parseRotationWindows({ hardBlockDays: 7, reducedWeightDays: 30, lookAheadDays: 0 })).toEqual(
      { hardBlockDays: 7, reducedWeightDays: 30, lookAheadDays: 0 },
    )
  })

  // Equal windows would render an empty reduced band, which reads as a
  // silently broken config rather than a deliberate choice.
  it.each([
    ['reduced equal to hard', { hardBlockDays: 14, reducedWeightDays: 14, lookAheadDays: 0 }],
    ['reduced below hard', { hardBlockDays: 30, reducedWeightDays: 14, lookAheadDays: 0 }],
    ['zero hard block', { hardBlockDays: 0, reducedWeightDays: 30, lookAheadDays: 0 }],
    ['negative hard block', { hardBlockDays: -1, reducedWeightDays: 30 }],
    ['fractional days', { hardBlockDays: 1.5, reducedWeightDays: 30 }],
    ['non-numeric', { hardBlockDays: '14', reducedWeightDays: 42 }],
    ['missing a field', { hardBlockDays: 14 }],
    ['not an object', 42],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    expect(parseRotationWindows(raw)).toBeNull()
  })

  it('rejects a reduced window past the ceiling', () => {
    expect(
      parseRotationWindows({
        hardBlockDays: 14,
        reducedWeightDays: MAX_REDUCED_WEIGHT_DAYS + 1,
      }),
    ).toBeNull()
    expect(
      parseRotationWindows({
        hardBlockDays: 14,
        reducedWeightDays: MAX_REDUCED_WEIGHT_DAYS,
      }),
    ).not.toBeNull()
  })
})
