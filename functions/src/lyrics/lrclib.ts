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
//   Pass 2 — title-only fallback: for songs whose songwriters
//   aren't also recording artists (e.g., "Oceans (Where Feet May
//   Fail)" was written by Matt Crocker / Joel Houston / Salomon
//   Ligthelm and recorded by Hillsong UNITED — no overlap), fall
//   back to `?track_name=<title>` and accept the first title-match.
//   Lyrics body is the same across worship covers; the popover
//   surfaces the recording artist so the user can see whose
//   version it is.
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

export async function fetchFromLrclib(query: LrclibQuery): Promise<LrclibResult> {
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
  // also recording artists (Oceans, etc.), accept the first
  // title-matched cover — worship covers preserve the lyric body.
  const results = await searchLrclib({ track_name: query.title })
  const titleMatched = results.filter((r) =>
    titlesMatchTolerantly(query.title, r.trackName),
  )
  if (titleMatched.length > 0) return toFoundResult(titleMatched[0])

  return notFound()
}
