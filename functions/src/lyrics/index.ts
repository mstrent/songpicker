import Anthropic from '@anthropic-ai/sdk'
import type { Firestore } from 'firebase-admin/firestore'

import {
  lyricsCacheKey,
  readLyricsCache,
  updateLyricsSnippets,
  writeLyricsCache,
  type LyricsCacheEntry,
} from './cache'
import { createLyricsDisambiguator } from './disambiguate'
import {
  enrichSnippets as enrichSnippetsCore,
  type EnrichOptions,
  type EnrichSnippetsDeps,
  type SnippetQuery,
  type SnippetResult,
} from './enrichSnippets'
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
export function defaultLyricsDeps(
  db: Firestore,
  anthropicApiKey?: string,
): OrchestratorDeps {
  const disambiguate = anthropicApiKey
    ? createLyricsDisambiguator(anthropicApiKey)
    : undefined
  return {
    readCache: (title, author) => readLyricsCache(db, title, author),
    writeCache: (title, author, result) =>
      writeLyricsCache(db, title, author, result),
    fetchLrclib: (q) => fetchFromLrclib(q, disambiguate),
  }
}

const HAIKU_MODEL = 'claude-haiku-5-5'

export function defaultEnrichDeps(
  db: Firestore,
  anthropicApiKey: string,
): EnrichSnippetsDeps {
  const client = new Anthropic({ apiKey: anthropicApiKey })
  const disambiguate = createLyricsDisambiguator(anthropicApiKey)

  return {
    async batchReadLyricsCache(
      queries: SnippetQuery[],
    ): Promise<Array<LyricsCacheEntry | null>> {
      if (queries.length === 0) return []
      const keys = queries.map((q) => lyricsCacheKey(q.title, q.author))
      const snaps = await db.getAll(
        ...keys.map((k) => db.collection('lyrics').doc(k)),
      )
      return snaps.map((snap) => {
        if (!snap.exists) return null
        const data = snap.data() as
          | (LyricsCacheEntry & { title?: string; author?: string })
          | undefined
        if (!data) return null
        return {
          found: data.found,
          plainLyrics: data.plainLyrics,
          instrumental: data.instrumental,
          lrclibId: data.lrclibId,
          artistName: data.artistName ?? null,
          source: data.source,
          fetchedAt: data.fetchedAt,
        }
      })
    },

    async fetchAndCacheLyrics(query: SnippetQuery): Promise<LrclibResult> {
      const t0 = Date.now()
      try {
        const fresh = await fetchFromLrclib(
          { title: query.title, author: query.author },
          disambiguate,
        )
        const ms = Date.now() - t0
        console.log(
          `[lyrics] fetched "${query.title}" in ${ms}ms (found=${fresh.found}, artist=${fresh.artistName ?? 'n/a'})`,
        )
        // Only cache when fetchFromLrclib actually returned a definitive
        // answer (found:true or a legitimate not-found). Transient
        // failures throw and we fall through — surface them upstream so
        // the next enrichment retries fresh instead of being poisoned
        // with a fake "not found" entry.
        await writeLyricsCache(db, query.title, query.author, fresh)
        return fresh
      } catch (err) {
        console.warn(
          `[lyrics] LRCLIB fetch failed for "${query.title}" by "${query.author ?? '(none)'}" after ${Date.now() - t0}ms — not caching`,
          err,
        )
        throw err
      }
    },

    async callHaiku(
      prompt: string,
      count: number,
    ): Promise<Record<string, string | null>> {
      // Structured output instead of regex-scraping a JSON object out
      // of prose. The keys are the numeric indices the prompt assigns
      // each song, so the schema can enumerate them exactly; a snippet
      // is a string, or null when the chorus couldn't be established.
      const properties: Record<string, unknown> = {}
      for (let i = 0; i < count; i++) {
        properties[String(i)] = {
          anyOf: [{ type: 'string' }, { type: 'null' }],
        }
      }
      const response = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 1024,
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties,
              required: Object.keys(properties),
              additionalProperties: false,
            },
          },
        },
        messages: [{ role: 'user', content: prompt }],
      })
      const text =
        response.content[0]?.type === 'text' ? response.content[0].text : ''
      // The schema guarantees the shape, but a refusal or a truncated
      // turn can still yield something unparseable — enrichSnippets
      // treats {} as "no snippets" and falls back to LRCLIB lines.
      try {
        return JSON.parse(text)
      } catch {
        return {}
      }
    },

    async writeSnippets(updates) {
      await updateLyricsSnippets(
        db,
        updates.map(({ query, snippet }) => ({
          title: query.title,
          author: query.author,
          snippet,
        })),
      )
    },
  }
}

export { enrichSnippetsCore as enrichSnippetsBatch }
export type { EnrichOptions, SnippetQuery, SnippetResult }
