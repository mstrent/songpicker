import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchFromLrclib } from './lrclib'

describe('fetchFromLrclib', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hits the LRCLIB /api/get endpoint with URL-encoded title + author', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 1,
        trackName: 'Reckless Love',
        artistName: 'Cory Asbury',
        albumName: null,
        duration: 240,
        instrumental: false,
        plainLyrics: 'Before I spoke a word\nYou were singing over me',
        syncedLyrics: null,
      }),
    } as Response)

    await fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://lrclib.net/api/get?artist_name=Cory+Asbury&track_name=Reckless+Love',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('returns a found result with plain lyrics on 200', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 42,
        trackName: 'Reckless Love',
        artistName: 'Cory Asbury',
        albumName: null,
        duration: 240,
        instrumental: false,
        plainLyrics: 'Before I spoke a word',
        syncedLyrics: null,
      }),
    } as Response)

    const result = await fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
    })
  })

  it('returns an instrumental result when LRCLIB marks the track instrumental', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 7,
        trackName: 'Interlude',
        artistName: 'Some Artist',
        albumName: null,
        duration: 60,
        instrumental: true,
        plainLyrics: null,
        syncedLyrics: null,
      }),
    } as Response)

    const result = await fetchFromLrclib({ title: 'Interlude', author: 'Some Artist' })

    expect(result).toEqual({
      found: true,
      plainLyrics: null,
      instrumental: true,
      lrclibId: 7,
    })
  })

  it('returns a not-found result on HTTP 404', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        code: 404,
        name: 'TrackNotFound',
        message: 'Failed to find specified track',
      }),
    } as Response)

    const result = await fetchFromLrclib({ title: 'Nonexistent', author: 'Nobody' })

    expect(result).toEqual({
      found: false,
      plainLyrics: null,
      instrumental: false,
      lrclibId: null,
    })
  })

  it('omits artist_name from the URL when author is missing', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ code: 404 }),
    } as Response)

    await fetchFromLrclib({ title: 'Reckless Love' })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://lrclib.net/api/get?track_name=Reckless+Love',
      expect.anything(),
    )
  })

  it('throws on a non-200/404 status', async () => {
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
