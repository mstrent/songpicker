import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchFromLrclib } from './lrclib'

describe('fetchFromLrclib', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hits the LRCLIB /api/search endpoint with title + author', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response)

    await fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://lrclib.net/api/search?artist_name=Cory+Asbury&track_name=Reckless+Love',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('returns a found result drawn from the first array element', async () => {
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

  it('returns an instrumental result when the top track is marked instrumental', async () => {
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

  it('handles a slash-separated author list (the case that motivated this change)', async () => {
    // PCO's author field for worship songs typically lists every
    // songwriter slash-separated. /api/get's exact-match required us
    // to special-case this; /api/search just ranks the right
    // recording first because tokens like "Pat Barrett" still match
    // a recording artist named "Pat Barrett".
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
    // Sanity-check that the slash-separated string was URL-encoded into the query.
    const callUrl = mockFetch.mock.calls[0][0] as string
    expect(callUrl).toContain('artist_name=')
    expect(callUrl).toContain('Pat+Barrett')
  })

  it('omits artist_name from the URL when author is missing', async () => {
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
})
