import { describe, expect, it, vi } from 'vitest'

import { getLyricsForSong } from './index'
import type { LrclibResult } from './lrclib'
import type { LyricsCacheEntry } from './cache'

describe('getLyricsForSong', () => {
  it('returns the cached entry on a hit and does not call LRCLIB', async () => {
    const cached: LyricsCacheEntry = {
      found: true,
      plainLyrics: 'Cached lyrics body',
      instrumental: false,
      lrclibId: 42,
      source: 'lrclib',
      fetchedAt: 1700000000000,
    }
    const deps = {
      readCache: vi.fn().mockResolvedValue(cached),
      writeCache: vi.fn().mockResolvedValue(undefined),
      fetchLrclib: vi.fn(),
    }

    const result = await getLyricsForSong(
      { title: 'Reckless Love', author: 'Cory Asbury' },
      deps,
    )

    expect(deps.readCache).toHaveBeenCalledWith('Reckless Love', 'Cory Asbury')
    expect(deps.fetchLrclib).not.toHaveBeenCalled()
    expect(deps.writeCache).not.toHaveBeenCalled()
    expect(result).toEqual({
      found: true,
      plainLyrics: 'Cached lyrics body',
      instrumental: false,
      source: 'lrclib',
      fetchedAt: 1700000000000,
      fromCache: true,
    })
  })

  it('calls LRCLIB and writes the cache on a miss', async () => {
    const lrclibResult: LrclibResult = {
      found: true,
      plainLyrics: 'Fresh lyrics body',
      instrumental: false,
      lrclibId: 99,
    }
    const deps = {
      readCache: vi.fn().mockResolvedValue(null),
      writeCache: vi.fn().mockResolvedValue(undefined),
      fetchLrclib: vi.fn().mockResolvedValue(lrclibResult),
    }

    const result = await getLyricsForSong(
      { title: 'Reckless Love', author: 'Cory Asbury' },
      deps,
    )

    expect(deps.fetchLrclib).toHaveBeenCalledWith({
      title: 'Reckless Love',
      author: 'Cory Asbury',
    })
    expect(deps.writeCache).toHaveBeenCalledWith(
      'Reckless Love',
      'Cory Asbury',
      lrclibResult,
    )
    expect(result).toMatchObject({
      found: true,
      plainLyrics: 'Fresh lyrics body',
      instrumental: false,
      source: 'lrclib',
      fromCache: false,
    })
    expect(typeof result.fetchedAt).toBe('number')
  })

  it('caches a negative result so the next call is a hit', async () => {
    const lrclibResult: LrclibResult = {
      found: false,
      plainLyrics: null,
      instrumental: false,
      lrclibId: null,
    }
    const deps = {
      readCache: vi.fn().mockResolvedValue(null),
      writeCache: vi.fn().mockResolvedValue(undefined),
      fetchLrclib: vi.fn().mockResolvedValue(lrclibResult),
    }

    await getLyricsForSong({ title: 'Nonexistent', author: 'Nobody' }, deps)

    expect(deps.writeCache).toHaveBeenCalledWith(
      'Nonexistent',
      'Nobody',
      lrclibResult,
    )
  })

  it('bypasses the cache when forceRefresh is true and overwrites with the fresh result', async () => {
    const cached: LyricsCacheEntry = {
      found: false,
      plainLyrics: null,
      instrumental: false,
      lrclibId: null,
      source: 'lrclib',
      fetchedAt: 1700000000000,
    }
    const lrclibResult: LrclibResult = {
      found: true,
      plainLyrics: 'Now found',
      instrumental: false,
      lrclibId: 7,
    }
    const deps = {
      readCache: vi.fn().mockResolvedValue(cached),
      writeCache: vi.fn().mockResolvedValue(undefined),
      fetchLrclib: vi.fn().mockResolvedValue(lrclibResult),
    }

    const result = await getLyricsForSong(
      { title: 'Reckless Love', author: 'Cory Asbury', forceRefresh: true },
      deps,
    )

    expect(deps.fetchLrclib).toHaveBeenCalled()
    expect(deps.writeCache).toHaveBeenCalledWith(
      'Reckless Love',
      'Cory Asbury',
      lrclibResult,
    )
    expect(result.found).toBe(true)
    expect(result.fromCache).toBe(false)
  })
})
