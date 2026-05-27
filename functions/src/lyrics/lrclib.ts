import { normalizeText } from '../normalize'

// LRCLIB is a free, no-API-key lyrics service. Lookup is multi-pass
// against /api/search:
//
//   Pass 1 — per-author-token: split PCO's songwriter string by /,
//   commas, and " and ", then query `?track_name=<title>&
//   artist_name=<token>` for each token in order. LRCLIB's
//   artist_name field is fuzzy on a single name (so "Matt Maher"
//   matches recordings credited to "Matt Maher") but it rejects
//   the whole PCO slash-list as one unmatched string. Iterating
//   one token at a time gets around that, and gating by author
//   token avoids title collisions (the worship "Lord I Need You"
//   vs Kanye's secular track of the same name).
//
//   Pass 2 — title-only fallback with AI disambiguation: for songs
//   whose songwriters aren't also recording artists (e.g., "Oceans"
//   by Crocker / Houston / Ligthelm, recorded by Hillsong UNITED),
//   fall back to `?track_name=<title>`. When multiple distinct songs
//   share the title (the worship "Yes I Will" vs Michael Franti's
//   unrelated track), results are grouped by lyrics fingerprint and
//   a Haiku classifier picks the correct worship version. Adds ~0.5s
//   only when there's genuine ambiguity — single-song results skip
//   the AI call entirely.
//
// Both passes filter the API results through titlesMatchTolerantly
// (parenthetical-suffix + light punctuation tolerant) so that fuzzy
// LRCLIB ranking can't sneak in unrelated tracks whose titles only
// loosely contain the search term ("Beat Surrender" for "Surrender").

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

// Split PCO's songwriter credit string ("Daniel Carson, Matt Maher,
// Christy Nockels, and Jesse Reeves" / "Brett Younker / Karl Martin /
// Pat Barrett") into individual names. The 2-char minimum drops
// degenerate fragments. Names are returned trimmed but un-normalized
// — the LRCLIB API endpoint matches case-insensitively on its end.
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

async function searchLrclib(
  params: Record<string, string>,
): Promise<LrclibTrackResponse[]> {
  const search = new URLSearchParams(params)
  const url = `${LRCLIB_SEARCH_URL}?${search.toString()}`
  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) {
    throw new Error(`LRCLIB request failed: HTTP ${res.status}`)
  }
  const data = await res.json()
  return Array.isArray(data) ? (data as LrclibTrackResponse[]) : []
}

export async function fetchFromLrclib(
  query: LrclibQuery,
  disambiguate?: LyricsDisambiguator,
): Promise<LrclibResult> {
  // Pass 1: try each author token as an artist_name hint, in order.
  // First search that returns a title-matched track wins.
  if (query.author) {
    for (const token of authorTokens(query.author)) {
      const results = await searchLrclib({
        track_name: query.title,
        artist_name: token,
      })
      const titleMatched = results.filter((r) =>
        titlesMatchTolerantly(query.title, r.trackName),
      )
      if (titleMatched.length > 0) return toFoundResult(titleMatched[0])
    }
  }

  // Pass 2: title-only fallback. For songs whose songwriters aren't
  // also recording artists (Oceans, etc.), search by title alone.
  // When multiple distinct songs share the title ("Yes I Will" the
  // worship song vs Michael Franti's "Yes I Will"), use the AI
  // disambiguator to pick the correct worship version.
  const results = await searchLrclib({ track_name: query.title })
  const titleMatched = results.filter((r) =>
    titlesMatchTolerantly(query.title, r.trackName),
  )
  if (titleMatched.length > 0) {
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
        if (pick >= 0 && pick < groups.length) {
          return toFoundResult(groups[pick][0])
        }
      } catch {
        // Disambiguation failed — fall through to first result
      }
    }
    return toFoundResult(titleMatched[0])
  }

  return notFound()
}
