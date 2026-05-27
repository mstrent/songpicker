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

  it('queries LRCLIB with track_name only (no artist_name)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
      track({ id: 42, trackName: 'Reckless Love', artistName: 'Cory Asbury', plainLyrics: 'Before I spoke a word' }),
    ]))

    await fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callUrl = mockFetch.mock.calls[0][0] as string
    expect(callUrl).toBe(
      'https://lrclib.net/api/search?track_name=Reckless+Love',
    )
    expect(callUrl).not.toContain('artist_name')
  })

  it('returns a found result with artistName populated', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
      track({ id: 42, trackName: 'Reckless Love', artistName: 'Cory Asbury', plainLyrics: 'Before I spoke a word' }),
    ]))

    const result = await fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
      artistName: 'Cory Asbury',
    })
  })

  it('returns an instrumental result when the top title-matching track is marked instrumental', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
      track({ id: 7, trackName: 'Interlude', artistName: 'Some Artist', instrumental: true, plainLyrics: null }),
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

  it('finds songs with one LRCLIB call regardless of how many songwriters PCO lists', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
      track({ id: 99, trackName: 'Lord, I Need You', artistName: 'Matt Maher', plainLyrics: 'Lord I come, I confess' }),
    ]))

    const result = await fetchFromLrclib({
      title: 'Lord I Need You',
      author: 'Daniel Carson, Matt Maher, Christy Nockels, and Jesse Reeves',
    })

    expect(result.found).toBe(true)
    expect(result.lrclibId).toBe(99)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('returns not-found when no title-matched results exist', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
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

  it('treats parenthetical-suffixed LRCLIB titles as a title match', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
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

  it('tolerates comma differences in the title compare ("Lord, I Need You" vs "Lord I Need You")', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
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

  it('throws on a non-200 status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response)

    await expect(
      fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' }),
    ).rejects.toThrow(/lrclib/i)
  })

  it('calls the disambiguator when results contain multiple distinct songs', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
      track({
        id: 1,
        trackName: 'Yes I Will',
        artistName: 'Michael Franti',
        plainLyrics: 'I received a letter, that you wrote me\nOn a dark, cold and cloudy day',
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
      { title: 'Yes I Will', author: 'Eddie Hoagland, Jonathan Smith, and Mia Fieldes' },
      disambiguate,
    )

    expect(result.found).toBe(true)
    expect(result.artistName).toBe('Vertical Worship')
    expect(result.plainLyrics).toContain('I count on one thing')

    expect(disambiguate).toHaveBeenCalledOnce()
    const [query, candidates] = disambiguate.mock.calls[0]
    expect(query.title).toBe('Yes I Will')
    expect(candidates).toHaveLength(2)
    expect(candidates[0].artistName).toBe('Michael Franti')
    expect(candidates[1].artistName).toBe('Vertical Worship')
  })

  it('skips disambiguator when all results share the same lyrics', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
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
    mockFetch.mockResolvedValueOnce(jsonResponse([
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
    mockFetch.mockResolvedValueOnce(jsonResponse([
      track({ id: 1, trackName: 'Song', artistName: 'Artist A', plainLyrics: 'lyrics A' }),
      track({ id: 2, trackName: 'Song', artistName: 'Artist B', plainLyrics: 'different lyrics B' }),
    ]))

    const result = await fetchFromLrclib({ title: 'Song', author: 'Nobody' })

    expect(result.found).toBe(true)
    expect(result.lrclibId).toBe(1)
  })
})
