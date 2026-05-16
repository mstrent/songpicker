import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchFromLrclib } from './lrclib'

describe('fetchFromLrclib', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hits the LRCLIB /api/search endpoint with track_name only (never artist_name)', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response)

    await fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' })

    const callUrl = mockFetch.mock.calls[0][0] as string
    expect(callUrl).toBe(
      'https://lrclib.net/api/search?track_name=Reckless+Love',
    )
    // Sanity: artist_name is never sent, even when an author is supplied,
    // because LRCLIB's strict-ish artist filter rejects PCO multi-songwriter
    // lists. See module comment.
    expect(callUrl).not.toContain('artist_name')
  })

  it('returns a found result drawn from the first title-matching array element', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 42,
          trackName: 'Reckless Love',
          artistName: 'Cory Asbury',
          albumName: null,
          duration: 240,
          instrumental: false,
          plainLyrics: 'Before I spoke a word',
          syncedLyrics: null,
        },
        {
          id: 43,
          trackName: 'Reckless Love (Live)',
          artistName: 'Cory Asbury',
          albumName: null,
          duration: 300,
          instrumental: false,
          plainLyrics: 'Different lyrics body',
          syncedLyrics: null,
        },
      ],
    } as Response)

    const result = await fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
    })
  })

  it('returns an instrumental result when the top title-matching track is marked instrumental', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 7,
          trackName: 'Interlude',
          artistName: 'Some Artist',
          albumName: null,
          duration: 60,
          instrumental: true,
          plainLyrics: null,
          syncedLyrics: null,
        },
      ],
    } as Response)

    const result = await fetchFromLrclib({ title: 'Interlude', author: 'Some Artist' })

    expect(result).toEqual({
      found: true,
      plainLyrics: null,
      instrumental: true,
      lrclibId: 7,
    })
  })

  it('returns a not-found result on an empty array', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response)

    const result = await fetchFromLrclib({ title: 'Nonexistent', author: 'Nobody' })

    expect(result).toEqual({
      found: false,
      plainLyrics: null,
      instrumental: false,
      lrclibId: null,
    })
  })

  it('handles a slash-separated author list (the case that motivated title-only search)', async () => {
    // PCO's author field is the full songwriter credit list. LRCLIB's
    // artist filter would AND-reject this whole string; sending
    // title only lets the song's actual recordings surface.
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 100,
          trackName: 'Build My Life',
          artistName: 'Pat Barrett',
          albumName: 'Pat Barrett',
          duration: 245,
          instrumental: false,
          plainLyrics: 'Worthy of every song we could ever sing',
          syncedLyrics: null,
        },
      ],
    } as Response)

    const result = await fetchFromLrclib({
      title: 'Build My Life',
      author: 'Brett Younker / Karl Martin / Kirby Kaple / Matt Redman / Pat Barrett',
    })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'Worthy of every song we could ever sing',
      instrumental: false,
      lrclibId: 100,
    })

    // The slash-separated author must NOT have been sent to LRCLIB.
    const callUrl = mockFetch.mock.calls[0][0] as string
    expect(callUrl).not.toContain('artist_name')
    expect(callUrl).not.toContain('Brett')
    expect(callUrl).not.toContain('Pat')
  })

  it('sends track_name even when no author is supplied (same URL shape)', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response)

    await fetchFromLrclib({ title: 'Reckless Love' })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://lrclib.net/api/search?track_name=Reckless+Love',
      expect.anything(),
    )
  })

  it('throws on a non-200 status', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response)

    await expect(
      fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' }),
    ).rejects.toThrow(/lrclib/i)
  })

  it('rejects an array whose results do not title-match the request', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 999,
          trackName: 'Totally Different Song',
          artistName: 'Some Artist',
          albumName: null,
          duration: 200,
          instrumental: false,
          plainLyrics: 'Unrelated lyrics body',
          syncedLyrics: null,
        },
      ],
    } as Response)

    const result = await fetchFromLrclib({ title: 'Build My Life', author: 'Pat Barrett' })

    expect(result).toEqual({
      found: false,
      plainLyrics: null,
      instrumental: false,
      lrclibId: null,
    })
  })

  it('skips earlier non-matching results and takes the first title-matching entry', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 1,
          trackName: 'Build',
          artistName: 'Random',
          albumName: null,
          duration: 100,
          instrumental: false,
          plainLyrics: 'unrelated',
          syncedLyrics: null,
        },
        {
          id: 2,
          trackName: 'Build My Life',
          artistName: 'Pat Barrett',
          albumName: null,
          duration: 245,
          instrumental: false,
          plainLyrics: 'Worthy of every song',
          syncedLyrics: null,
        },
      ],
    } as Response)

    const result = await fetchFromLrclib({ title: 'Build My Life', author: 'Pat Barrett' })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'Worthy of every song',
      instrumental: false,
      lrclibId: 2,
    })
  })

  it('treats parenthetical-suffixed LRCLIB titles as a match (with author overlap via feat.)', async () => {
    // "Build My Life (feat. Pat Barrett)" — the artistName contains
    // "Pat Barrett" via the feat. credit, so the author-token check
    // accepts this even though the primary artist is Bethel Music.
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 50,
          trackName: 'Build My Life (feat. Pat Barrett)',
          artistName: 'Bethel Music feat. Pat Barrett',
          albumName: 'Peace, Vol. II',
          duration: 318,
          instrumental: false,
          plainLyrics: 'Worthy of every song',
          syncedLyrics: null,
        },
      ],
    } as Response)

    const result = await fetchFromLrclib({ title: 'Build My Life', author: 'Pat Barrett' })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'Worthy of every song',
      instrumental: false,
      lrclibId: 50,
    })
  })

  it('rejects a title-matched result when no artist token overlaps with the author (Kanye vs Matt Maher)', async () => {
    // LRCLIB returns "Lord I Need You" by Kanye West at position 0
    // when PCO has the Matt Maher worship song credited to multiple
    // worship songwriters. Title matches; author overlap doesn't.
    // We reject rather than render Kanye lyrics for a worship song.
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 1000,
          trackName: 'Lord I Need You',
          artistName: 'Kanye West',
          albumName: 'Jesus Is King',
          duration: 219,
          instrumental: false,
          plainLyrics: '(Lord, I need You to wrap Your arms around me)',
          syncedLyrics: null,
        },
      ],
    } as Response)

    const result = await fetchFromLrclib({
      title: 'Lord I Need You',
      author: 'Daniel Carson, Matt Maher, Christy Nockels, and Jesse Reeves',
    })

    expect(result).toEqual({
      found: false,
      plainLyrics: null,
      instrumental: false,
      lrclibId: null,
    })
  })

  it('picks the result whose artist overlaps with the author tokens, not just the first title match', async () => {
    // LRCLIB ranks the wrong-artist version at position 0. We walk
    // past it and take the author-token-matched version further down.
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 1,
          trackName: 'Lord I Need You',
          artistName: 'Kanye West',
          albumName: null,
          duration: 219,
          instrumental: false,
          plainLyrics: 'kanye lyrics',
          syncedLyrics: null,
        },
        {
          id: 2,
          trackName: 'Lord, I Need You',
          artistName: 'Matt Maher',
          albumName: null,
          duration: 240,
          instrumental: false,
          plainLyrics: 'Lord I come, I confess',
          syncedLyrics: null,
        },
      ],
    } as Response)

    const result = await fetchFromLrclib({
      title: 'Lord I Need You',
      author: 'Daniel Carson, Matt Maher, Christy Nockels, and Jesse Reeves',
    })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'Lord I come, I confess',
      instrumental: false,
      lrclibId: 2,
    })
  })

  it('falls back to first title match when no author is supplied (no overlap check possible)', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 1,
          trackName: 'Reckless Love',
          artistName: 'Anyone',
          albumName: null,
          duration: 240,
          instrumental: false,
          plainLyrics: 'matched lyrics',
          syncedLyrics: null,
        },
      ],
    } as Response)

    const result = await fetchFromLrclib({ title: 'Reckless Love' })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'matched lyrics',
      instrumental: false,
      lrclibId: 1,
    })
  })

  it('handles "and"-joined author lists ("X and Y")', async () => {
    // PCO sometimes uses " and " as the final separator. The token
    // splitter should treat that as a delimiter so "Pat Barrett"
    // gets extracted from "X and Pat Barrett".
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 7,
          trackName: 'Some Song',
          artistName: 'Pat Barrett',
          albumName: null,
          duration: 200,
          instrumental: false,
          plainLyrics: 'lyrics',
          syncedLyrics: null,
        },
      ],
    } as Response)

    const result = await fetchFromLrclib({
      title: 'Some Song',
      author: 'Matt Redman and Pat Barrett',
    })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'lyrics',
      instrumental: false,
      lrclibId: 7,
    })
  })
})
