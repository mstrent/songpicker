import type { Firestore } from 'firebase-admin/firestore'

import {
  readLyricsCache,
  writeLyricsCache,
  type LyricsCacheEntry,
} from './cache'
import { fetchFromLrclib, type LrclibResult } from './lrclib'

export interface GetLyricsRequest {
  title: string
  author?: string
  /** Skip the cache read and re-query LRCLIB. The fresh result is
   *  written back into the cache, replacing any prior value. Used
   *  for the modal's manual "Re-check LRCLIB" button. */
  forceRefresh?: boolean
}

export interface GetLyricsResult {
  found: boolean
  plainLyrics: string | null
  instrumental: boolean
  /** Recording artist on the matched track (NOT the requested PCO
   *  songwriter list). Null for not-found results and for entries
   *  cached before this field was tracked. */
  artistName: string | null
  source: 'lrclib'
  fetchedAt: number
  fromCache: boolean
}

interface OrchestratorDeps {
  readCache(title: string, author: string | undefined): Promise<LyricsCacheEntry | null>
  writeCache(
    title: string,
    author: string | undefined,
    result: LrclibResult,
  ): Promise<void>
  fetchLrclib(query: { title: string; author?: string }): Promise<LrclibResult>
}

export async function getLyricsForSong(
  req: GetLyricsRequest,
  deps: OrchestratorDeps,
): Promise<GetLyricsResult> {
  if (!req.forceRefresh) {
    const cached = await deps.readCache(req.title, req.author)
    if (cached) {
      return {
        found: cached.found,
        plainLyrics: cached.plainLyrics,
        instrumental: cached.instrumental,
        artistName: cached.artistName,
        source: cached.source,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
      }
    }
  }

  const fresh = await deps.fetchLrclib({ title: req.title, author: req.author })
  await deps.writeCache(req.title, req.author, fresh)
  return {
    found: fresh.found,
    plainLyrics: fresh.plainLyrics,
    instrumental: fresh.instrumental,
    artistName: fresh.artistName,
    source: 'lrclib',
    fetchedAt: Date.now(),
    fromCache: false,
  }
}

// Default-deps factory wires the orchestrator to real Firestore + LRCLIB.
// The callable in index.ts uses this; tests inject their own deps.
export function defaultLyricsDeps(db: Firestore): OrchestratorDeps {
  return {
    readCache: (title, author) => readLyricsCache(db, title, author),
    writeCache: (title, author, result) => writeLyricsCache(db, title, author, result),
    fetchLrclib: (q) => fetchFromLrclib(q),
  }
}
