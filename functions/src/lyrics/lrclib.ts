import { normalizeText } from '../normalize'

// LRCLIB is a free, no-API-key lyrics service. We hit its
// /api/search endpoint with track_name only — NOT artist_name.
//
// Why title-only on the wire: LRCLIB treats artist_name as a
// strict-ish AND filter. PCO's song.author field lists every credited
// songwriter slash-separated (e.g., "Brett Younker / Karl Martin /
// Kirby Kaple / Matt Redman / Pat Barrett" for "Build My Life"), and
// no recording artist's name contains that whole string, so passing
// artist_name returns empty arrays even when LRCLIB has the song under
// a clean artist name. Title-only returns the full ranked list, then
// we filter client-side.
//
// Client-side gating happens in two passes:
//
//   1. titlesMatchTolerantly — keep only results whose trackName
//      matches the requested title (parenthetical-suffix tolerant
//      via stripParentheticals).
//
//   2. Author-token overlap — when an author is supplied (almost
//      always — PCO populates it), require the chosen result's
//      recording artist to contain at least one token from the
//      requested author. Without this guard, "Lord I Need You"
//      returns Kanye West's track at position 0 and the Matt Maher
//      worship version several positions down, and we'd happily
//      render Kanye's lyrics for the worship song.

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
// degenerate fragments from "&" leftovers or stray "I"/"a" tokens.
function authorTokens(author: string): string[] {
  return author
    .split(/[/,]|\sand\s/gi)
    .map((t) => normalizeText(t))
    .filter((t) => t.length >= 2)
}

function artistContainsAnyToken(artist: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false
  const norm = normalizeText(artist)
  return tokens.some((t) => norm.includes(t))
}

function notFound(): LrclibResult {
  return { found: false, plainLyrics: null, instrumental: false, lrclibId: null }
}

function toFoundResult(r: LrclibTrackResponse): LrclibResult {
  return {
    found: true,
    plainLyrics: r.plainLyrics,
    instrumental: r.instrumental,
    lrclibId: r.id,
  }
}

export async function fetchFromLrclib(query: LrclibQuery): Promise<LrclibResult> {
  const params = new URLSearchParams()
  params.set('track_name', query.title)
  const url = `${LRCLIB_SEARCH_URL}?${params.toString()}`

  const res = await fetch(url, { method: 'GET' })

  if (!res.ok) {
    throw new Error(`LRCLIB request failed: HTTP ${res.status}`)
  }

  const results = (await res.json()) as LrclibTrackResponse[]
  if (!Array.isArray(results)) return notFound()

  const titleMatched = results.filter((r) =>
    titlesMatchTolerantly(query.title, r.trackName),
  )
  if (titleMatched.length === 0) return notFound()

  // With an author, require recording-artist overlap with one of the
  // songwriter tokens. No overlap → not found (safer than serving
  // wrong-song lyrics).
  if (query.author) {
    const tokens = authorTokens(query.author)
    const authorMatched = titleMatched.find((r) =>
      artistContainsAnyToken(r.artistName, tokens),
    )
    if (authorMatched) return toFoundResult(authorMatched)
    return notFound()
  }

  // No author supplied — best-effort take first title match.
  return toFoundResult(titleMatched[0])
}
