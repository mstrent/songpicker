import { normalizeText } from '../normalize'

// LRCLIB is a free, no-API-key lyrics service. We hit its
// /api/search endpoint with track_name only — NOT artist_name.
//
// Why title-only: LRCLIB treats artist_name as a strict-ish AND
// filter. PCO's song.author field for worship songs lists every
// credited songwriter slash-separated (e.g., "Brett Younker / Karl
// Martin / Kirby Kaple / Matt Redman / Pat Barrett" for "Build My
// Life"), and no recording artist's name contains that whole
// string, so passing artist_name returns empty arrays even when
// LRCLIB has the song under a clean artist name. Title-only
// returns the full ranked list, and titlesMatchTolerantly below
// prevents accepting unrelated tracks.
//
// We still walk the array and filter to results whose trackName
// matches the requested title under normalizeText rules
// (parenthetical-suffix tolerant). Author is intentionally NOT
// used to constrain the query or to rank results — for our
// purpose (showing the user the lyric for a song they identified
// by title), any same-title recording's lyric body is correct,
// and LRCLIB's own relevance ranking handles the priority.

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

function titlesMatchTolerantly(a: string, b: string): boolean {
  const na = normalizeText(stripParentheticals(a))
  const nb = normalizeText(stripParentheticals(b))
  return na.length > 0 && na === nb
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
  if (!Array.isArray(results)) {
    return { found: false, plainLyrics: null, instrumental: false, lrclibId: null }
  }

  const match = results.find((r) => titlesMatchTolerantly(query.title, r.trackName))
  if (!match) {
    return { found: false, plainLyrics: null, instrumental: false, lrclibId: null }
  }

  return {
    found: true,
    plainLyrics: match.plainLyrics,
    instrumental: match.instrumental,
    lrclibId: match.id,
  }
}
