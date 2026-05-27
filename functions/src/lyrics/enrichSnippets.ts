import type { LyricsCacheEntry } from './cache'
import type { LrclibResult } from './lrclib'

export interface SnippetQuery {
  title: string
  author?: string
}

export type SnippetSource = 'lrclib' | 'haiku-extract' | 'haiku-generate'

export interface SnippetResult {
  snippet: string | null
  source: SnippetSource
}

export interface EnrichSnippetsDeps {
  batchReadLyricsCache(
    queries: SnippetQuery[],
  ): Promise<Array<LyricsCacheEntry | null>>
  fetchAndCacheLyrics(query: SnippetQuery): Promise<LrclibResult>
  callHaiku(prompt: string): Promise<Record<string, string | null>>
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

  return `Extract a 2–4 line chorus or representative snippet from each song. For songs with lyrics provided, extract the most recognizable repeated section. For songs without lyrics, recall the chorus if you are confident you know it — otherwise return null.

Reply as JSON only: {"0": "snippet or null", "1": "snippet or null", ...}
Use the numeric keys shown below. Return null (not the string "null") for songs you cannot extract or recall.

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

export async function enrichSnippets(
  queries: SnippetQuery[],
  deps: EnrichSnippetsDeps,
): Promise<SnippetResult[]> {
  if (queries.length === 0) return []

  const cached = await deps.batchReadLyricsCache(queries)

  const lyrics: Array<string | null> = []
  const fetchPromises: Array<Promise<void>> = []
  for (let i = 0; i < queries.length; i++) {
    const entry = cached[i]
    if (entry?.found && entry.plainLyrics) {
      lyrics[i] = entry.plainLyrics
    } else {
      lyrics[i] = null
      fetchPromises.push(
        deps
          .fetchAndCacheLyrics(queries[i])
          .then((r) => {
            if (r.found && r.plainLyrics) lyrics[i] = r.plainLyrics
          })
          .catch(() => {}),
      )
    }
  }
  await Promise.all(fetchPromises)

  const haikuInput = queries.map((q, i) => ({
    index: i,
    title: q.title,
    author: q.author,
    lyrics: lyrics[i],
  }))

  let haikuSnippets: Array<string | null>
  try {
    const raw = await deps.callHaiku(buildHaikuPrompt(haikuInput))
    haikuSnippets = parseHaikuResponse(raw, queries.length)
  } catch {
    haikuSnippets = queries.map(() => null)
  }

  return queries.map((_, i): SnippetResult => {
    const snippet = haikuSnippets[i] ?? null
    if (!snippet) {
      return { snippet: null, source: lyrics[i] ? 'lrclib' : 'haiku-generate' }
    }
    if (lyrics[i]) {
      return { snippet, source: 'lrclib' }
    }
    return { snippet, source: 'haiku-generate' }
  })
}
