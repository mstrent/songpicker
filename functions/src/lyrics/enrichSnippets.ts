import type { LyricsCacheEntry } from './cache'
import type { LrclibResult } from './lrclib'

export interface SnippetQuery {
  title: string
  author?: string
}

export type SnippetSource = 'lrclib' | 'haiku-extract' | 'haiku-generate'

export interface SnippetResult {
  snippet: string | null
  source: SnippetSource | null
  plainLyrics: string | null
  artistName: string | null
}

export interface EnrichSnippetsDeps {
  batchReadLyricsCache(
    queries: SnippetQuery[],
  ): Promise<Array<LyricsCacheEntry | null>>
  fetchAndCacheLyrics(query: SnippetQuery): Promise<LrclibResult>
  /** `count` is the number of songs in the prompt — the implementation
   *  uses it to build a structured-output schema with exactly those
   *  numeric keys, so the reply can't come back in an unexpected shape. */
  callHaiku(
    prompt: string,
    count: number,
  ): Promise<Record<string, string | null>>
  /** Persist extracted snippets back into the lyrics cache so future
   *  calls for the same songs skip the Haiku extraction entirely. */
  writeSnippets(
    updates: Array<{ query: SnippetQuery; snippet: string | null }>,
  ): Promise<void>
}

function buildHaikuPrompt(
  songs: Array<{
    index: number
    title: string
    author?: string
    lyrics: string | null
  }>,
): string {
  const parts = songs.map((s) => {
    if (s.lyrics) {
      return `${s.index}. "${s.title}"${s.author ? ` by ${s.author}` : ''}\n\n${s.lyrics}`
    }
    return `${s.index}. "${s.title}"${s.author ? ` by ${s.author}` : ''}\n\n(No lyrics available — recall from knowledge if confident)`
  })

  return `For each song below, extract a 2–3 line chorus from the provided lyrics — never more than 3 lines. If lyrics are missing, recall the chorus only if you're confident — otherwise use null.

Reply as JSON keyed by the numeric index: {"0": "...", "1": null, ...}

${parts.join('\n\n---\n\n')}`
}

function parseHaikuResponse(
  raw: Record<string, string | null>,
  count: number,
): Array<string | null> {
  const results: Array<string | null> = []
  for (let i = 0; i < count; i++) {
    const val = raw[String(i)]
    results.push(typeof val === 'string' && val.trim() ? val.trim() : null)
  }
  return results
}

export interface EnrichOptions {
  forceRefresh?: boolean
}

export async function enrichSnippets(
  queries: SnippetQuery[],
  deps: EnrichSnippetsDeps,
  options?: EnrichOptions,
): Promise<SnippetResult[]> {
  if (queries.length === 0) return []

  const t0 = Date.now()
  const tag = `[enrichSnippets] n=${queries.length}${options?.forceRefresh ? ' (forceRefresh)' : ''}`

  const lyrics: Array<string | null> = []
  const artists: Array<string | null> = []
  const fetchPromises: Array<Promise<void>> = []
  // undefined = not in cache / not yet checked; string | null = cached value
  const cachedSnippets: Array<string | null | undefined> = queries.map(
    () => undefined,
  )
  let cacheHits = 0
  let lrclibFetches = 0

  if (options?.forceRefresh) {
    for (let i = 0; i < queries.length; i++) {
      lyrics[i] = null
      artists[i] = null
      lrclibFetches++
      fetchPromises.push(
        deps
          .fetchAndCacheLyrics(queries[i])
          .then((r) => {
            if (r.found && r.plainLyrics) lyrics[i] = r.plainLyrics
            artists[i] = r.artistName
          })
          .catch(() => {}),
      )
    }
  } else {
    const tCacheStart = Date.now()
    const cached = await deps.batchReadLyricsCache(queries)
    console.log(
      `${tag} cache read: ${Date.now() - tCacheStart}ms`,
    )
    for (let i = 0; i < queries.length; i++) {
      const entry = cached[i]
      if (entry !== null && 'snippet' in entry && entry.snippet !== undefined) {
        cachedSnippets[i] = entry.snippet
      }
      if (entry?.found && entry.plainLyrics) {
        lyrics[i] = entry.plainLyrics
        artists[i] = entry.artistName
        cacheHits++
      } else {
        lyrics[i] = null
        artists[i] = null
        lrclibFetches++
        fetchPromises.push(
          deps
            .fetchAndCacheLyrics(queries[i])
            .then((r) => {
              if (r.found && r.plainLyrics) lyrics[i] = r.plainLyrics
              artists[i] = r.artistName
            })
            .catch(() => {}),
        )
      }
    }
  }

  const tFetchStart = Date.now()
  await Promise.all(fetchPromises)
  const fetchMs = Date.now() - tFetchStart
  const songsWithLyrics = lyrics.filter((l) => l).length
  console.log(
    `${tag} fetches: ${fetchMs}ms (cache hits: ${cacheHits}, LRCLIB fetches: ${lrclibFetches}, lyrics resolved: ${songsWithLyrics}/${queries.length})`,
  )

  // Indices that don't have a cached snippet yet — these need Haiku.
  const needsHaiku = queries
    .map((_, i) => i)
    .filter((i) => cachedSnippets[i] === undefined)

  // haikuSnippets[i] holds the result for query i (cached or extracted).
  const haikuSnippets: Array<string | null> = queries.map((_, i) =>
    cachedSnippets[i] !== undefined ? (cachedSnippets[i] ?? null) : null,
  )

  if (needsHaiku.length > 0) {
    const haikuInput = needsHaiku.map((qi, j) => ({
      index: j,
      title: queries[qi].title,
      author: queries[qi].author,
      lyrics: lyrics[qi],
    }))
    const promptTokensApprox = Math.round(
      buildHaikuPrompt(haikuInput).length / 4,
    )
    const tHaikuStart = Date.now()
    let extracted: Array<string | null>
    try {
      const raw = await deps.callHaiku(
        buildHaikuPrompt(haikuInput),
        needsHaiku.length,
      )
      extracted = parseHaikuResponse(raw, needsHaiku.length)
      console.log(
        `${tag} haiku extraction: ${Date.now() - tHaikuStart}ms (~${promptTokensApprox} input tokens, ${needsHaiku.length}/${queries.length} songs)`,
      )
    } catch (err) {
      console.warn(
        `${tag} haiku extraction failed after ${Date.now() - tHaikuStart}ms (~${promptTokensApprox} input tokens):`,
        err,
      )
      extracted = needsHaiku.map(() => null)
    }
    for (let j = 0; j < needsHaiku.length; j++) {
      haikuSnippets[needsHaiku[j]] = extracted[j]
    }
    // Write back extracted snippets so future calls skip Haiku for these songs.
    deps
      .writeSnippets(
        needsHaiku.map((qi, j) => ({
          query: queries[qi],
          snippet: extracted[j] ?? null,
        })),
      )
      .catch(() => {})
  } else {
    console.log(`${tag} all snippets from cache — skipped Haiku`)
  }

  console.log(`${tag} total: ${Date.now() - t0}ms`)

  return queries.map((_, i): SnippetResult => {
    const pl = lyrics[i] ?? null
    const ar = artists[i] ?? null
    const rawSnippet = haikuSnippets[i] ?? null
    // Hard cap at 3 non-blank lines regardless of what Haiku produced.
    // The prompt asks for 2-3 lines but Haiku sometimes returns more,
    // which leads to wall-of-text snippets on the card.
    const snippet = rawSnippet
      ? rawSnippet
          .split('\n')
          .filter((l) => l.trim())
          .slice(0, 3)
          .join('\n') || null
      : null
    if (!snippet && pl) {
      const fallback = pl
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 3)
        .join('\n')
      return fallback
        ? { snippet: fallback, source: 'lrclib', plainLyrics: pl, artistName: ar }
        : { snippet: null, source: null, plainLyrics: pl, artistName: ar }
    }
    if (!snippet) {
      return { snippet: null, source: null, plainLyrics: pl, artistName: ar }
    }
    if (pl) {
      return { snippet, source: 'lrclib', plainLyrics: pl, artistName: ar }
    }
    return { snippet, source: 'haiku-generate', plainLyrics: null, artistName: null }
  })
}
