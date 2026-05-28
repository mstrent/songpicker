import { normalizeText } from '../normalize'

// LRCLIB is a free, no-API-key lyrics service. We do a fan-out
// search to maximize coverage, then disambiguate:
//
//   In parallel, query `?track_name=<title>` (title-only) AND
//   `?track_name=<title>&artist_name=<token>` for each songwriter
//   token from the PCO author string. LRCLIB's title-only search
//   has a result cap that can push worship versions off the page
//   when popular secular songs share the title — author-token
//   queries surface those hidden entries. Running them in parallel
//   keeps latency to one round-trip.
//
//   All results are deduplicated by id, filtered through
//   titlesMatchTolerantly (parenthetical-suffix + light punctuation
//   tolerant) so fuzzy LRCLIB ranking can't sneak in unrelated tracks
//   ("Beat Surrender" for "Surrender"), and grouped by lyrics
//   fingerprint so cover versions of the same composition collapse
//   into one group.
//
//   When multiple distinct songs share the title, a Haiku classifier
//   picks the correct worship version. Haiku can also signal "none
//   of these is the worship song" → we return notFound rather than
//   guessing.

const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search'

export interface LrclibQuery {
  title: string
  author?: string
}

export interface LrclibResult {
  found: boolean
  plainLyrics: string | null
  instrumental: boolean
  lrclibId: number | null
  /** Recording artist of the matched track (NOT the PCO songwriter
   *  list). Surfaced to the popover so users can see whose version's
   *  lyrics they're reading — especially useful when a worship song's
   *  songwriters aren't also recording artists and we land on a cover. */
  artistName: string | null
}

interface LrclibTrackResponse {
  id: number
  trackName: string
  artistName: string
  albumName: string | null
  duration: number | null
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

function stripParentheticals(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
}

// Strip common title punctuation (commas, periods, colons, hyphens,
// etc.) so LRCLIB's "Lord, I Need You" matches PCO's "Lord I Need You"
// after normalization. Slashes are excluded — they're delimiters in
// our author/songwriter context, not title separators.
function stripPunctuation(s: string): string {
  return s
    .replace(/[,.;:!?\-–—_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titlesMatchTolerantly(a: string, b: string): boolean {
  const na = normalizeText(stripPunctuation(stripParentheticals(a)))
  const nb = normalizeText(stripPunctuation(stripParentheticals(b)))
  return na.length > 0 && na === nb
}

function authorTokens(author: string): string[] {
  return author
    .split(/[/,]|\sand\s/gi)
    .map((t) => t.trim())
    .filter((t) => normalizeText(t).length >= 2)
}

export interface DisambiguationCandidate {
  artistName: string
  albumName: string | null
  lyricsPreview: string
}

/**
 * Returns the index of the best-matching candidate, or -1 to signal
 * "none of these is the correct song" (we'll return notFound).
 */
export type LyricsDisambiguator = (
  query: LrclibQuery,
  candidates: DisambiguationCandidate[],
) => Promise<number>

function lyricsFingerprint(lyrics: string | null): string {
  if (!lyrics) return ''
  return lyrics
    .slice(0, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function groupByLyrics(
  results: LrclibTrackResponse[],
): LrclibTrackResponse[][] {
  const groups = new Map<string, LrclibTrackResponse[]>()
  for (const r of results) {
    const fp = lyricsFingerprint(r.plainLyrics)
    if (!fp) continue
    const group = groups.get(fp) ?? []
    group.push(r)
    groups.set(fp, group)
  }
  return Array.from(groups.values())
}

function notFound(): LrclibResult {
  return {
    found: false,
    plainLyrics: null,
    instrumental: false,
    lrclibId: null,
    artistName: null,
  }
}

function toFoundResult(r: LrclibTrackResponse): LrclibResult {
  return {
    found: true,
    plainLyrics: r.plainLyrics,
    instrumental: r.instrumental,
    lrclibId: r.id,
    artistName: r.artistName,
  }
}

// Bound the number of in-flight LRCLIB HTTP requests across the whole
// process. LRCLIB is a free service and we've seen response times balloon
// to 8-20s per call when we hit it with 5 concurrent requests — they
// appear to throttle by slowing responses rather than returning 429.
// Keeping concurrency low keeps each call fast (~500ms-1s) and produces
// better overall throughput than firing 5+ requests that each take 10s.
const LRCLIB_CONCURRENCY = 2
let lrclibActive = 0
const lrclibWaiters: Array<() => void> = []

async function withLrclibSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (lrclibActive >= LRCLIB_CONCURRENCY) {
    await new Promise<void>((resolve) => lrclibWaiters.push(resolve))
  }
  lrclibActive++
  try {
    return await fn()
  } finally {
    lrclibActive--
    const next = lrclibWaiters.shift()
    if (next) next()
  }
}

function parseRetryAfterMs(header: string | null): number {
  if (!header) return 0
  const n = parseInt(header, 10)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n * 1000, 5000)
}

async function searchLrclib(
  params: Record<string, string>,
): Promise<LrclibTrackResponse[]> {
  const search = new URLSearchParams(params)
  const url = `${LRCLIB_SEARCH_URL}?${search.toString()}`

  const queueDepth = lrclibActive + lrclibWaiters.length
  const tQueued = Date.now()
  return withLrclibSlot(async () => {
    const waited = Date.now() - tQueued
    // Single retry on transient errors (429, 5xx). Honors Retry-After
    // when present; otherwise backs off 500ms. After the retry, a
    // continuing failure throws so the caller can decide whether to
    // cache notFound or skip caching.
    for (let attempt = 0; attempt < 2; attempt++) {
      const tFetch = Date.now()
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) {
        const data = await res.json()
        const n = Array.isArray(data) ? data.length : 0
        console.log(
          `[lrclib] ${params.artist_name ? `artist=${params.artist_name}` : 'title-only'} "${params.track_name}" → ${n} results in ${Date.now() - tFetch}ms (queue wait ${waited}ms, depth was ${queueDepth})`,
        )
        return Array.isArray(data) ? (data as LrclibTrackResponse[]) : []
      }
      const transient = res.status === 429 || res.status >= 500
      if (transient && attempt === 0) {
        const wait =
          parseRetryAfterMs(res.headers.get('Retry-After')) || 500
        console.warn(
          `[lrclib] HTTP ${res.status} for ${url} — retrying in ${wait}ms`,
        )
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw new Error(`LRCLIB request failed: HTTP ${res.status}`)
    }
    throw new Error('LRCLIB request failed: retries exhausted')
  })
}

export async function fetchFromLrclib(
  query: LrclibQuery,
  disambiguate?: LyricsDisambiguator,
): Promise<LrclibResult> {
  const queries: Array<Record<string, string>> = [
    { track_name: query.title },
  ]
  if (query.author) {
    for (const token of authorTokens(query.author)) {
      queries.push({ track_name: query.title, artist_name: token })
    }
  }

  const settled = await Promise.allSettled(queries.map((q) => searchLrclib(q)))

  const errorCount = settled.filter((s) => s.status === 'rejected').length
  if (errorCount > 0) {
    const sample = settled.find((s) => s.status === 'rejected')
    const reason = sample && sample.status === 'rejected' ? sample.reason : ''
    console.warn(
      `[lrclib] ${errorCount}/${queries.length} fan-out queries failed for "${query.title}" (sample: ${reason})`,
    )
  }
  // If every fan-out query failed, this is a transient outage — throw
  // so the caller skips caching notFound. Partial failure with at least
  // one successful response is treated as a real (if narrower) result.
  if (errorCount === queries.length) {
    throw new Error(
      `LRCLIB unavailable: all ${queries.length} queries failed for "${query.title}"`,
    )
  }

  const byId = new Map<number, LrclibTrackResponse>()
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue
    for (const r of s.value) {
      if (!byId.has(r.id)) byId.set(r.id, r)
    }
  }
  const combined = Array.from(byId.values())
  const titleMatched = combined.filter((r) =>
    titlesMatchTolerantly(query.title, r.trackName),
  )
  if (titleMatched.length === 0) return notFound()

  const groups = groupByLyrics(titleMatched)
  if (groups.length > 1 && disambiguate) {
    const representatives = groups.map((g) => ({
      artistName: g[0].artistName,
      albumName: g[0].albumName,
      lyricsPreview:
        g[0].plainLyrics?.split('\n').slice(0, 2).join(' / ') ?? '',
    }))
    try {
      const pick = await disambiguate(query, representatives)
      if (pick === -1) return notFound()
      if (pick >= 0 && pick < groups.length) {
        return toFoundResult(groups[pick][0])
      }
    } catch {
      // Disambiguation failed — fall through to first result
    }
  }
  return toFoundResult(titleMatched[0])
}
