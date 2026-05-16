import { describe, expect, it, vi } from 'vitest'

import { lyricsCacheKey, readLyricsCache, writeLyricsCache } from './cache'

describe('lyricsCacheKey', () => {
  it('produces a stable 40-char hex hash for a given title+author', () => {
    const key = lyricsCacheKey('Reckless Love', 'Cory Asbury')
    expect(key).toMatch(/^[0-9a-f]{40}$/)
    expect(key).toBe(lyricsCacheKey('Reckless Love', 'Cory Asbury'))
  })

  it('treats normalized-equivalent inputs as the same key', () => {
    expect(lyricsCacheKey('Reckless Love', 'Cory Asbury')).toBe(
      lyricsCacheKey('  RECKLESS LOVE  ', 'cory asbury'),
    )
    expect(lyricsCacheKey('The Lion and the Lamb', 'Bethel')).toBe(
      lyricsCacheKey('Lion and the Lamb', 'Bethel'),
    )
    expect(lyricsCacheKey('Bread & Wine', 'Hillsong')).toBe(
      lyricsCacheKey('Bread and Wine', 'Hillsong'),
    )
  })

  it('produces different keys for different songs', () => {
    expect(lyricsCacheKey('Reckless Love', 'Cory Asbury')).not.toBe(
      lyricsCacheKey('Holy Spirit', 'Bryan & Katie Torwalt'),
    )
  })

  it('produces different keys for same title, different authors', () => {
    expect(lyricsCacheKey('Surrender', 'Marc James')).not.toBe(
      lyricsCacheKey('Surrender', 'Hillsong'),
    )
  })

  it('treats missing author the same as empty string', () => {
    expect(lyricsCacheKey('Reckless Love')).toBe(
      lyricsCacheKey('Reckless Love', ''),
    )
  })
})

function makeFakeDb() {
  // Minimal Firestore-shaped stub: collection().doc().get()/set() chain.
  const store = new Map<string, unknown>()
  return {
    store,
    collection(name: string) {
      expect(name).toBe('lyrics')
      return {
        doc(key: string) {
          return {
            async get() {
              const data = store.get(key)
              return {
                exists: data !== undefined,
                data: () => data,
              }
            },
            async set(value: unknown) {
              store.set(key, value)
            },
          }
        },
      }
    },
  }
}

describe('readLyricsCache', () => {
  it('returns null when no doc exists for the key', async () => {
    const fakeDb = makeFakeDb()
    const result = await readLyricsCache(
      fakeDb as unknown as Parameters<typeof readLyricsCache>[0],
      'Reckless Love',
      'Cory Asbury',
    )
    expect(result).toBeNull()
  })

  it('returns the cached entry when one exists', async () => {
    const fakeDb = makeFakeDb()
    const key = lyricsCacheKey('Reckless Love', 'Cory Asbury')
    fakeDb.store.set(key, {
      title: 'Reckless Love',
      author: 'Cory Asbury',
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
      source: 'lrclib',
      fetchedAt: 1700000000000,
    })

    const result = await readLyricsCache(
      fakeDb as unknown as Parameters<typeof readLyricsCache>[0],
      'Reckless Love',
      'Cory Asbury',
    )
    expect(result).toEqual({
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
      artistName: null,
      source: 'lrclib',
      fetchedAt: 1700000000000,
    })
  })
})

describe('writeLyricsCache', () => {
  it('writes the entry under the derived key and includes title+author for debugging', async () => {
    const fakeDb = makeFakeDb()
    const now = vi.fn().mockReturnValue(1700000000000)

    await writeLyricsCache(
      fakeDb as unknown as Parameters<typeof writeLyricsCache>[0],
      'Reckless Love',
      'Cory Asbury',
      {
        found: true,
        plainLyrics: 'Before I spoke a word',
        instrumental: false,
        lrclibId: 42,
        artistName: 'Cory Asbury',
      },
      now,
    )

    const key = lyricsCacheKey('Reckless Love', 'Cory Asbury')
    expect(fakeDb.store.get(key)).toEqual({
      title: 'Reckless Love',
      author: 'Cory Asbury',
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
      artistName: 'Cory Asbury',
      source: 'lrclib',
      fetchedAt: 1700000000000,
    })
  })

  it('stores empty-string author when none was supplied', async () => {
    const fakeDb = makeFakeDb()
    await writeLyricsCache(
      fakeDb as unknown as Parameters<typeof writeLyricsCache>[0],
      'Reckless Love',
      undefined,
      { found: false, plainLyrics: null, instrumental: false, lrclibId: null, artistName: null },
      () => 1700000000000,
    )

    const key = lyricsCacheKey('Reckless Love')
    const entry = fakeDb.store.get(key) as { author: string }
    expect(entry.author).toBe('')
  })
})
