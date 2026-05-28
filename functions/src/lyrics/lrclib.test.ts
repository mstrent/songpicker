import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchFromLrclib } from './lrclib'

type MockFetch = ReturnType<typeof vi.fn>

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

function track(overrides: Partial<{
  id: number
  trackName: string
  artistName: string
  albumName: string | null
  duration: number | null
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}> = {}) {
  return {
    id: 1,
    trackName: 'Some Song',
    artistName: 'Some Artist',
    albumName: null,
    duration: 240,
    instrumental: false,
    plainLyrics: 'lyrics body',
    syncedLyrics: null,
    ...overrides,
  }
}

describe('fetchFromLrclib', () => {
  let mockFetch: MockFetch
  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fans out title-only + per-author-token searches in parallel', async () => {
    // Title-only returns 0 worship matches; author-token returns the
    // worship hit. This is the "Lay Me Down" case where LRCLIB's
    // title-only result cap pushes worship versions off the page.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('artist_name=Chris+Tomlin')) {
        return jsonResponse([
          track({
            id: 100,
            trackName: 'Lay Me Down',
            artistName: 'Chris Tomlin',
            plainLyrics: 'With this heart open wide',
          }),
        ])
      }
      // Title-only returns only secular songs
      return jsonResponse([
        track({
          id: 1,
          trackName: 'Lay Me Down',
          artistName: 'Sam Smith',
          plainLyrics: 'Yes, I do, I believe',
        }),
      ])
    })

    const disambiguate = vi.fn().mockResolvedValue(1) // picks worship

    const result = await fetchFromLrclib(
      { title: 'Lay Me Down', author: 'Chris Tomlin' },
      disambiguate,
    )

    expect(result.found).toBe(true)
    expect(result.artistName).toBe('Chris Tomlin')
    expect(result.plainLyrics).toBe('With this heart open wide')
    // 1 title-only + 1 author-token = 2 calls, in parallel
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('queries one URL per songwriter token plus title-only', async () => {
    mockFetch.mockResolvedValue(jsonResponse([]))

    await fetchFromLrclib({
      title: 'Song',
      author: 'Chris Tomlin, Jonas Myrin, and Matt Redman',
    })

    // 1 title-only + 3 author tokens = 4 parallel calls
    expect(mockFetch).toHaveBeenCalledTimes(4)
    const urls = mockFetch.mock.calls.map((c) => c[0] as string)
    expect(urls.some((u) => !u.includes('artist_name'))).toBe(true)
    expect(urls.some((u) => u.includes('artist_name=Chris+Tomlin'))).toBe(true)
    expect(urls.some((u) => u.includes('artist_name=Jonas+Myrin'))).toBe(true)
    expect(urls.some((u) => u.includes('artist_name=Matt+Redman'))).toBe(true)
  })

  it('deduplicates results that appear in multiple search responses', async () => {
    // Same id returned by both title-only and author-token searches —
    // should only appear once in the disambiguation.
    mockFetch.mockResolvedValue(jsonResponse([
      track({
        id: 42,
        trackName: 'Reckless Love',
        artistName: 'Cory Asbury',
        plainLyrics: 'Before I spoke a word',
      }),
    ]))

    const result = await fetchFromLrclib({
      title: 'Reckless Love',
      author: 'Cory Asbury',
    })

    expect(result.found).toBe(true)
    expect(result.lrclibId).toBe(42)
  })

  it('returns a found result with artistName populated', async () => {
    mockFetch.mockResolvedValue(jsonResponse([
      track({
        id: 42,
        trackName: 'Reckless Love',
        artistName: 'Cory Asbury',
        plainLyrics: 'Before I spoke a word',
      }),
    ]))

    const result = await fetchFromLrclib({
      title: 'Reckless Love',
      author: 'Cory Asbury',
    })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
      artistName: 'Cory Asbury',
    })
  })

  it('returns an instrumental result when the matching track is marked instrumental', async () => {
    mockFetch.mockResolvedValue(jsonResponse([
      track({
        id: 7,
        trackName: 'Interlude',
        artistName: 'Some Artist',
        instrumental: true,
        plainLyrics: null,
      }),
    ]))

    const result = await fetchFromLrclib({ title: 'Interlude', author: 'Some Artist' })

    expect(result).toEqual({
      found: true,
      plainLyrics: null,
      instrumental: true,
      lrclibId: 7,
      artistName: 'Some Artist',
    })
  })

  it('returns notFound when no title-matched results exist anywhere', async () => {
    mockFetch.mockResolvedValue(jsonResponse([
      track({ id: 999, trackName: 'Totally Different Song', artistName: 'Random' }),
    ]))

    const result = await fetchFromLrclib({ title: 'Nonexistent', author: 'Nobody' })

    expect(result).toEqual({
      found: false,
      plainLyrics: null,
      instrumental: false,
      lrclibId: null,
      artistName: null,
    })
  })

  it('skips disambiguator when a result is recorded by a songwriter (artist-match shortcut)', async () => {
    // "Your Love Awakens Me" — PCO lists "Phil Wickham, Chris McClarney"
    // as songwriters; LRCLIB has multiple Phil Wickham recordings with
    // subtly different lyrics formatting (studio vs acoustic vs lyric
    // video). Without the shortcut, lyrics-fingerprint grouping would
    // split them, the disambiguator would fire, and Haiku might return
    // -1 confused by the songwriter-vs-recording-artist mismatch.
    mockFetch.mockResolvedValue(jsonResponse([
      track({
        id: 1,
        trackName: 'Your Love Awakens Me',
        artistName: 'Phil Wickham',
        plainLyrics: 'Your love awakens me / Out of the dust I rise',
      }),
      track({
        id: 2,
        trackName: 'Your Love Awakens Me (Acoustic)',
        artistName: 'Phil Wickham',
        plainLyrics: 'Your love awakens me // Out of the dust I rise',
      }),
    ]))

    const disambiguate = vi.fn()

    const result = await fetchFromLrclib(
      { title: 'Your Love Awakens Me', author: 'Phil Wickham, Chris McClarney' },
      disambiguate,
    )

    expect(result.found).toBe(true)
    expect(result.artistName).toBe('Phil Wickham')
    expect(disambiguate).not.toHaveBeenCalled()
  })

  it('returns notFound when the disambiguator signals -1 (no candidate is the worship song)', async () => {
    // All results are secular pop songs — Haiku correctly says "none"
    mockFetch.mockResolvedValue(jsonResponse([
      track({
        id: 1,
        trackName: 'Lay Me Down',
        artistName: 'Sam Smith',
        plainLyrics: 'Yes, I do, I believe',
      }),
      track({
        id: 2,
        trackName: 'Lay Me Down',
        artistName: 'Sissy Nobby',
        plainLyrics: 'It felt like spring time on this February morning',
      }),
    ]))

    const disambiguate = vi.fn().mockResolvedValue(-1)

    const result = await fetchFromLrclib(
      { title: 'Lay Me Down', author: 'Chris Tomlin, Matt Redman' },
      disambiguate,
    )

    expect(result.found).toBe(false)
    expect(disambiguate).toHaveBeenCalledOnce()
  })

  it('treats parenthetical-suffixed LRCLIB titles as a title match', async () => {
    mockFetch.mockResolvedValue(jsonResponse([
      track({
        id: 50,
        trackName: 'Build My Life (feat. Pat Barrett)',
        artistName: 'Bethel Music feat. Pat Barrett',
        plainLyrics: 'Worthy of every song',
      }),
    ]))

    const result = await fetchFromLrclib({
      title: 'Build My Life',
      author: 'Pat Barrett',
    })

    expect(result.found).toBe(true)
    expect(result.lrclibId).toBe(50)
  })

  it('tolerates comma differences in the title compare', async () => {
    mockFetch.mockResolvedValue(jsonResponse([
      track({
        id: 70,
        trackName: 'Lord, I Need You',
        artistName: 'Matt Maher',
        plainLyrics: 'Lord I come, I confess',
      }),
    ]))

    const result = await fetchFromLrclib({
      title: 'Lord I Need You',
      author: 'Matt Maher',
    })

    expect(result.found).toBe(true)
    expect(result.lrclibId).toBe(70)
  })

  it('proceeds with partial results when one search throws', async () => {
    // Title-only succeeds, but the author-token search returns 404.
    // We should still return the title-only match.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('artist_name')) {
        return {
          ok: false,
          status: 404,
          headers: new Headers(),
          json: async () => ({}),
        } as Response
      }
      return jsonResponse([
        track({
          id: 1,
          trackName: 'Song',
          artistName: 'Artist',
          plainLyrics: 'lyrics',
        }),
      ])
    })

    const result = await fetchFromLrclib({
      title: 'Song',
      author: 'Some Author',
    })

    expect(result.found).toBe(true)
    expect(result.lrclibId).toBe(1)
  })

  it('throws when ALL fan-out queries fail (transient outage)', async () => {
    // Every query returns 404 — fetchFromLrclib should throw so the
    // caller can skip caching (otherwise we poison the cache with a
    // false "not found" that persists until forceRefresh).
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({}),
    } as Response)

    await expect(
      fetchFromLrclib({ title: 'Some Song', author: 'Some Author' }),
    ).rejects.toThrow(/LRCLIB unavailable/)
  })

  it('calls the disambiguator when results contain multiple distinct songs', async () => {
    mockFetch.mockResolvedValue(jsonResponse([
      track({
        id: 1,
        trackName: 'Yes I Will',
        artistName: 'Michael Franti',
        plainLyrics:
          'I received a letter, that you wrote me\nOn a dark, cold and cloudy day',
      }),
      track({
        id: 10,
        trackName: 'Yes I Will',
        artistName: 'Vertical Worship',
        plainLyrics: 'I count on one thing\nThe same God who never fails',
      }),
    ]))

    const disambiguate = vi.fn().mockResolvedValue(1)

    const result = await fetchFromLrclib(
      { title: 'Yes I Will', author: 'Eddie Hoagland' },
      disambiguate,
    )

    expect(result.found).toBe(true)
    expect(result.artistName).toBe('Vertical Worship')
    expect(result.plainLyrics).toContain('I count on one thing')

    expect(disambiguate).toHaveBeenCalledOnce()
    const [query, candidates] = disambiguate.mock.calls[0]
    expect(query.title).toBe('Yes I Will')
    expect(candidates).toHaveLength(2)
  })

  it('skips disambiguator when all results share the same lyrics', async () => {
    mockFetch.mockResolvedValue(jsonResponse([
      track({
        id: 10,
        trackName: 'Yes I Will',
        artistName: 'Vertical Worship',
        plainLyrics: 'I count on one thing\nThe same God who never fails',
      }),
      track({
        id: 11,
        trackName: 'Yes I Will',
        artistName: 'Anthem Lights',
        plainLyrics: 'I count on one thing\nThe same God who never fails',
      }),
    ]))

    const disambiguate = vi.fn()

    const result = await fetchFromLrclib(
      { title: 'Yes I Will', author: 'Nobody' },
      disambiguate,
    )

    expect(result.found).toBe(true)
    expect(disambiguate).not.toHaveBeenCalled()
  })

  it('falls back to first result when disambiguator throws', async () => {
    mockFetch.mockResolvedValue(jsonResponse([
      track({
        id: 1,
        trackName: 'Grace',
        artistName: 'Pop Artist',
        plainLyrics: 'Some pop lyrics here',
      }),
      track({
        id: 10,
        trackName: 'Grace',
        artistName: 'Worship Artist',
        plainLyrics: 'Your grace is enough',
      }),
    ]))

    const disambiguate = vi.fn().mockRejectedValue(new Error('API down'))

    const result = await fetchFromLrclib(
      { title: 'Grace', author: 'Nobody' },
      disambiguate,
    )

    expect(result.found).toBe(true)
    expect(result.lrclibId).toBe(1)
  })

  it('falls back to first result when no disambiguator is provided', async () => {
    mockFetch.mockResolvedValue(jsonResponse([
      track({ id: 1, trackName: 'Song', artistName: 'Artist A', plainLyrics: 'lyrics A' }),
      track({ id: 2, trackName: 'Song', artistName: 'Artist B', plainLyrics: 'different lyrics B' }),
    ]))

    const result = await fetchFromLrclib({ title: 'Song', author: 'Nobody' })

    expect(result.found).toBe(true)
    expect(result.lrclibId).toBe(1)
  })
})
