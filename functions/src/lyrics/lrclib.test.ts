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

  it('queries LRCLIB with track_name + artist_name per author token when author is supplied', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
      track({ id: 42, trackName: 'Reckless Love', artistName: 'Cory Asbury', plainLyrics: 'Before I spoke a word' }),
    ]))

    await fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' })

    const callUrl = mockFetch.mock.calls[0][0] as string
    expect(callUrl).toBe(
      'https://lrclib.net/api/search?track_name=Reckless+Love&artist_name=Cory+Asbury',
    )
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

  it('iterates through author tokens in order and stops at the first title-matched response', async () => {
    // Tokens: "Daniel Carson" (empty) → "Matt Maher" (hit).
    mockFetch.mockResolvedValueOnce(jsonResponse([])) // Daniel Carson
    mockFetch.mockResolvedValueOnce(jsonResponse([   // Matt Maher
      track({ id: 99, trackName: 'Lord, I Need You', artistName: 'Matt Maher', plainLyrics: 'Lord I come, I confess' }),
    ]))

    const result = await fetchFromLrclib({
      title: 'Lord I Need You',
      author: 'Daniel Carson, Matt Maher, Christy Nockels, and Jesse Reeves',
    })

    expect(result.found).toBe(true)
    expect(result.lrclibId).toBe(99)
    expect(result.artistName).toBe('Matt Maher')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][0]).toContain('artist_name=Daniel+Carson')
    expect(mockFetch.mock.calls[1][0]).toContain('artist_name=Matt+Maher')
  })

  it('falls back to title-only search when every author-token search is empty (cover case)', async () => {
    // PCO's author for "Oceans" is "Matt Crocker / Joel Houston / Salomon
    // Ligthelm" — none of whom are recording artists. All three artist_name
    // searches return empty; we fall back to track_name only and pick the
    // first title-matched cover.
    mockFetch.mockResolvedValueOnce(jsonResponse([])) // Matt Crocker
    mockFetch.mockResolvedValueOnce(jsonResponse([])) // Joel Houston
    mockFetch.mockResolvedValueOnce(jsonResponse([])) // Salomon Ligthelm
    mockFetch.mockResolvedValueOnce(jsonResponse([   // title-only fallback
      track({
        id: 200,
        trackName: 'Oceans (Where Feet May Fail)',
        artistName: 'Hillsong UNITED',
        plainLyrics: 'You call me out upon the waters',
      }),
    ]))

    const result = await fetchFromLrclib({
      title: 'Oceans (Where Feet May Fail)',
      author: 'Matt Crocker / Joel Houston / Salomon Ligthelm',
    })

    expect(result.found).toBe(true)
    expect(result.lrclibId).toBe(200)
    expect(result.artistName).toBe('Hillsong UNITED')

    // 3 token searches + 1 fallback = 4 fetches.
    expect(mockFetch).toHaveBeenCalledTimes(4)
    // The fallback request has no artist_name.
    const fallbackUrl = mockFetch.mock.calls[3][0] as string
    expect(fallbackUrl).not.toContain('artist_name')
  })

  it('returns not-found when even the title-only fallback yields no title-match', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([])) // token search empty
    mockFetch.mockResolvedValueOnce(jsonResponse([   // title-only: only loosely-related fuzz
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

  it('rejects title-mismatched results within a token-search response (avoids Kanye for Matt Maher)', async () => {
    // The Daniel Carson token search comes back with Kanye West's track at
    // position 0 (LRCLIB fuzzy matched). titlesMatchTolerantly is fine but
    // the search itself returned tracks that don't match — though here it
    // happens to match... wait, our guard is that *some* track from this
    // response title-matches. Let's emulate a response where everything is
    // off-title (LRCLIB fuzzy noise): then we move to the next token.
    mockFetch.mockResolvedValueOnce(jsonResponse([
      track({ id: 1, trackName: 'Lord I Need Y\'all', artistName: 'Off-title fuzz', plainLyrics: 'unrelated' }),
    ]))
    mockFetch.mockResolvedValueOnce(jsonResponse([
      track({ id: 2, trackName: 'Lord, I Need You', artistName: 'Matt Maher', plainLyrics: 'Lord I come, I confess' }),
    ]))

    const result = await fetchFromLrclib({
      title: 'Lord I Need You',
      author: 'Daniel Carson, Matt Maher',
    })

    expect(result.lrclibId).toBe(2)
    expect(result.artistName).toBe('Matt Maher')
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

  it('queries track_name only when no author is supplied', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]))

    await fetchFromLrclib({ title: 'Reckless Love' })

    const callUrl = mockFetch.mock.calls[0][0] as string
    expect(callUrl).toBe(
      'https://lrclib.net/api/search?track_name=Reckless+Love',
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
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

  it('handles "and"-joined author lists by splitting into tokens', async () => {
    // First token "Matt Redman" returns empty; second token "Pat Barrett"
    // returns the result. Validates that " and " is treated as a delimiter.
    mockFetch.mockResolvedValueOnce(jsonResponse([])) // Matt Redman
    mockFetch.mockResolvedValueOnce(jsonResponse([   // Pat Barrett
      track({ id: 7, trackName: 'Some Song', artistName: 'Pat Barrett', plainLyrics: 'lyrics' }),
    ]))

    const result = await fetchFromLrclib({
      title: 'Some Song',
      author: 'Matt Redman and Pat Barrett',
    })

    expect(result.lrclibId).toBe(7)
    expect(mockFetch.mock.calls[0][0]).toContain('artist_name=Matt+Redman')
    expect(mockFetch.mock.calls[1][0]).toContain('artist_name=Pat+Barrett')
  })
})
