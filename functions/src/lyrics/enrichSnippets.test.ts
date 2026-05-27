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
    expect(results[0]).toEqual({
      snippet: 'I count on one thing\nThe same God who never fails',
      source: 'lrclib',
    })
    expect(results[1]).toEqual({
      snippet: 'Come let us worship our King\nCome let us bow at His feet',
      source: 'lrclib',
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

    expect(results[0]).toEqual({
      snippet: 'Spirit lead me where my trust is without borders',
      source: 'lrclib',
    })
    expect(results[1]).toEqual({
      snippet: null,
      source: null,
    })
  })

  it('falls back to first lines of lyrics when Haiku call fails', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        {
          found: true,
          plainLyrics: 'The battle rages on\nAs storms and tempests roar\nWe cannot win this fight',
          artistName: 'Chris Tomlin',
        },
      ]),
      callHaiku: vi.fn().mockRejectedValue(new Error('API down')),
    })

    const results = await enrichSnippets([{ title: 'White Flag' }], deps)

    expect(results[0]).toEqual({
      snippet: 'The battle rages on\nAs storms and tempests roar\nWe cannot win this fight',
      source: 'lrclib',
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

    expect(results[0]).toEqual({
      snippet: 'Line one\nLine two\nLine three\nLine four',
      source: 'lrclib',
    })
  })

  it('returns null for LRCLIB miss when Haiku also fails', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([null]),
      fetchAndCacheLyrics: vi.fn().mockResolvedValue({
        found: false, plainLyrics: null, instrumental: false, artistName: null,
      }),
      callHaiku: vi.fn().mockRejectedValue(new Error('API down')),
    })

    const results = await enrichSnippets([{ title: 'Unknown Song' }], deps)

    expect(results[0]).toEqual({ snippet: null, source: null })
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
    expect(results[0]).toEqual({
      snippet: 'Way maker miracle worker',
      source: 'lrclib',
    })
  })
})
