import { describe, expect, it, vi } from 'vitest'

import { enrichSnippets, type EnrichSnippetsDeps } from './enrichSnippets'

function makeDeps(
  overrides: Partial<EnrichSnippetsDeps> = {},
): EnrichSnippetsDeps {
  return {
    batchReadLyricsCache: vi.fn().mockResolvedValue([]),
    fetchAndCacheLyrics: vi.fn().mockResolvedValue({
      found: false,
      plainLyrics: null,
      instrumental: false,
      artistName: null,
    }),
    callHaiku: vi.fn().mockResolvedValue({}),
    writeSnippets: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('enrichSnippets', () => {
  it('returns LRCLIB-extracted snippets when all songs are cached', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        {
          found: true,
          plainLyrics:
            'I count on one thing\nThe same God who never fails\nWill be faithful',
          artistName: 'Vertical Worship',
        },
        {
          found: true,
          plainLyrics:
            'Come let us worship our King\nCome let us bow at His feet',
          artistName: 'Phil Wickham',
        },
      ]),
      callHaiku: vi.fn().mockResolvedValue({
        '0': 'I count on one thing\nThe same God who never fails',
        '1': 'Come let us worship our King\nCome let us bow at His feet',
      }),
    })

    const results = await enrichSnippets(
      [
        { title: 'Yes I Will', author: 'Eddie Hoagland' },
        { title: 'Great Things', author: 'Phil Wickham' },
      ],
      deps,
    )

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      snippet: 'I count on one thing\nThe same God who never fails',
      source: 'lrclib',
      artistName: 'Vertical Worship',
    })
    expect(results[0].plainLyrics).toContain('I count on one thing')
    expect(results[1]).toMatchObject({
      snippet: 'Come let us worship our King\nCome let us bow at His feet',
      source: 'lrclib',
      artistName: 'Phil Wickham',
    })
  })

  it('falls back to haiku-generate for LRCLIB misses', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([null]),
      fetchAndCacheLyrics: vi.fn().mockResolvedValue({
        found: false,
        plainLyrics: null,
        instrumental: false,
        artistName: null,
      }),
      callHaiku: vi.fn().mockResolvedValue({
        '0': 'Amazing grace how sweet the sound',
      }),
    })

    const results = await enrichSnippets(
      [{ title: 'Amazing Grace', author: 'John Newton' }],
      deps,
    )

    expect(results[0]).toEqual({
      snippet: 'Amazing grace how sweet the sound',
      source: 'haiku-generate',
      plainLyrics: null,
      artistName: null,
    })
  })

  it('handles mixed LRCLIB hits and misses in one batch', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        {
          found: true,
          plainLyrics: 'You call me out upon the waters',
          artistName: 'Hillsong',
        },
        null,
      ]),
      fetchAndCacheLyrics: vi.fn().mockResolvedValue({
        found: false,
        plainLyrics: null,
        instrumental: false,
        artistName: null,
      }),
      callHaiku: vi.fn().mockResolvedValue({
        '0': 'Spirit lead me where my trust is without borders',
        '1': null,
      }),
    })

    const results = await enrichSnippets(
      [{ title: 'Oceans', author: 'Hillsong' }, { title: 'Obscure Hymn' }],
      deps,
    )

    expect(results[0]).toMatchObject({
      snippet: 'Spirit lead me where my trust is without borders',
      source: 'lrclib',
      artistName: 'Hillsong',
    })
    expect(results[1]).toEqual({
      snippet: null,
      source: null,
      plainLyrics: null,
      artistName: null,
    })
  })

  it('falls back to first lines of lyrics when Haiku call fails', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        {
          found: true,
          plainLyrics:
            'The battle rages on\nAs storms and tempests roar\nWe cannot win this fight',
          artistName: 'Chris Tomlin',
        },
      ]),
      callHaiku: vi.fn().mockRejectedValue(new Error('API down')),
    })

    const results = await enrichSnippets([{ title: 'White Flag' }], deps)

    expect(results[0]).toMatchObject({
      snippet:
        'The battle rages on\nAs storms and tempests roar\nWe cannot win this fight',
      source: 'lrclib',
      artistName: 'Chris Tomlin',
    })
  })

  it('falls back to first lines when Haiku omits a song from its response', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        {
          found: true,
          plainLyrics: 'Line one\nLine two\nLine three\nLine four\nLine five',
          artistName: 'Artist',
        },
      ]),
      callHaiku: vi.fn().mockResolvedValue({}),
    })

    const results = await enrichSnippets([{ title: 'Some Song' }], deps)

    expect(results[0]).toMatchObject({
      snippet: 'Line one\nLine two\nLine three',
      source: 'lrclib',
      artistName: 'Artist',
    })
  })

  it('caps Haiku-returned snippets at 3 lines', async () => {
    // Even when prompted for 2-3 lines, Haiku sometimes returns 4+
    // and the card ends up a wall of text. The server-side cap is
    // belt-and-suspenders.
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        {
          found: true,
          plainLyrics: 'whatever lyrics here',
          artistName: 'Artist',
        },
      ]),
      callHaiku: vi.fn().mockResolvedValue({
        '0': 'Oh the overwhelming\nNever-ending reckless love\nIt chases me down\nFights til I am found',
      }),
    })

    const results = await enrichSnippets([{ title: 'Reckless Love' }], deps)

    expect(results[0].snippet).toBe(
      'Oh the overwhelming\nNever-ending reckless love\nIt chases me down',
    )
  })

  it('returns null for LRCLIB miss when Haiku also fails', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([null]),
      fetchAndCacheLyrics: vi.fn().mockResolvedValue({
        found: false,
        plainLyrics: null,
        instrumental: false,
        artistName: null,
      }),
      callHaiku: vi.fn().mockRejectedValue(new Error('API down')),
    })

    const results = await enrichSnippets([{ title: 'Unknown Song' }], deps)

    expect(results[0]).toEqual({
      snippet: null,
      source: null,
      plainLyrics: null,
      artistName: null,
    })
  })

  it('returns empty array for empty input', async () => {
    const deps = makeDeps()
    const results = await enrichSnippets([], deps)
    expect(results).toEqual([])
    expect(deps.batchReadLyricsCache).not.toHaveBeenCalled()
  })

  it('fetches from LRCLIB when cache misses and uses the result', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([null]),
      fetchAndCacheLyrics: vi.fn().mockResolvedValue({
        found: true,
        plainLyrics: 'Way maker miracle worker',
        instrumental: false,
        lrclibId: 1,
        artistName: 'Sinach',
      }),
      callHaiku: vi.fn().mockResolvedValue({
        '0': 'Way maker miracle worker',
      }),
    })

    const results = await enrichSnippets(
      [{ title: 'Way Maker', author: 'Sinach' }],
      deps,
    )

    expect(deps.fetchAndCacheLyrics).toHaveBeenCalledWith({
      title: 'Way Maker',
      author: 'Sinach',
    })
    expect(results[0]).toMatchObject({
      snippet: 'Way maker miracle worker',
      source: 'lrclib',
      artistName: 'Sinach',
    })
  })

  it('skips Haiku when all songs have cached snippets', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        {
          found: true,
          plainLyrics: 'Already extracted lyrics',
          artistName: 'Artist',
          snippet: 'Cached chorus line one\nCached chorus line two',
        },
      ]),
    })

    const results = await enrichSnippets([{ title: 'Cached Song' }], deps)

    expect(deps.callHaiku).not.toHaveBeenCalled()
    expect(deps.writeSnippets).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({
      snippet: 'Cached chorus line one\nCached chorus line two',
      source: 'lrclib',
      artistName: 'Artist',
    })
  })

  it('uses cached snippet for some songs and calls Haiku only for the rest', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        {
          found: true,
          plainLyrics: 'lyrics one',
          artistName: 'Artist A',
          snippet: 'Cached snippet for song one',
        },
        {
          found: true,
          plainLyrics: 'lyrics two',
          artistName: 'Artist B',
          // no snippet field — needs Haiku
        },
      ]),
      callHaiku: vi.fn().mockResolvedValue({ '0': 'Haiku snippet for song two' }),
    })

    const results = await enrichSnippets(
      [{ title: 'Song One' }, { title: 'Song Two' }],
      deps,
    )

    expect(deps.callHaiku).toHaveBeenCalledTimes(1)
    // Haiku only received the one song that needed extraction (index 0 in the sub-batch)
    const haikuPrompt = (deps.callHaiku as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(haikuPrompt).toContain('Song Two')
    expect(haikuPrompt).not.toContain('Song One')

    expect(results[0]).toMatchObject({
      snippet: 'Cached snippet for song one',
      source: 'lrclib',
    })
    expect(results[1]).toMatchObject({
      snippet: 'Haiku snippet for song two',
      source: 'lrclib',
    })

    expect(deps.writeSnippets).toHaveBeenCalledWith([
      { query: { title: 'Song Two' }, snippet: 'Haiku snippet for song two' },
    ])
  })

  it('writes extracted snippets back to cache after Haiku runs', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        { found: true, plainLyrics: 'some lyrics', artistName: 'Artist' },
      ]),
      callHaiku: vi.fn().mockResolvedValue({ '0': 'Extracted chorus' }),
    })

    await enrichSnippets([{ title: 'Song', author: 'Author' }], deps)

    expect(deps.writeSnippets).toHaveBeenCalledWith([
      { query: { title: 'Song', author: 'Author' }, snippet: 'Extracted chorus' },
    ])
  })

  it('writes null snippet to cache when Haiku extraction fails', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        { found: true, plainLyrics: 'some lyrics', artistName: 'Artist' },
      ]),
      callHaiku: vi.fn().mockRejectedValue(new Error('API down')),
    })

    await enrichSnippets([{ title: 'Song' }], deps)

    expect(deps.writeSnippets).toHaveBeenCalledWith([
      { query: { title: 'Song' }, snippet: null },
    ])
  })

  it('skips cache and re-fetches when forceRefresh is true', async () => {
    const deps = makeDeps({
      fetchAndCacheLyrics: vi.fn().mockResolvedValue({
        found: true,
        plainLyrics: 'Fresh lyrics from LRCLIB',
        instrumental: false,
        lrclibId: 1,
        artistName: 'Artist',
      }),
      callHaiku: vi.fn().mockResolvedValue({
        '0': 'Fresh lyrics from LRCLIB',
      }),
    })

    const results = await enrichSnippets(
      [{ title: 'Song' }],
      deps,
      { forceRefresh: true },
    )

    expect(deps.batchReadLyricsCache).not.toHaveBeenCalled()
    expect(deps.fetchAndCacheLyrics).toHaveBeenCalled()
    expect(results[0]).toMatchObject({
      snippet: 'Fresh lyrics from LRCLIB',
      source: 'lrclib',
    })
  })
})
