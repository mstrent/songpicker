import { normalizeText } from '../normalize'

// LRCLIB is a free, no-API-key lyrics service. We use its
// /api/search endpoint (not /api/get) because PCO's song.author
// field lists every songwriter slash-separated (e.g., "Brett
// Younker / Karl Martin / Kirby Kaple / Matt Redman / Pat Barrett"
// for "Build My Life"), while LRCLIB indexes recordings by their
// performing artist. /api/get is exact-match and 404s on those
// strings even when LRCLIB has the song under a clean artist name;
// /api/search ranks fuzzy matches and surfaces the right recording
// at position 0 in both the clean case ("Cory Asbury" → "Reckless
// Love") and the slash-list case.
//
// The fuzzy ranking sometimes returns weak matches as results[0]
// when the song genuinely isn't in LRCLIB's index — so we filter
// the array to results whose trackName matches the requested
// title under normalizeText rules (and tolerate parenthetical
// suffixes like "(Live)", "(feat. ...)", "(Hillsong)"). Empty
// after filtering → not-found.

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

// LRCLIB's track names commonly carry parenthetical suffixes:
// "(Live)", "(Acoustic)", "(feat. X)", "(Hillsong)". PCO and AI
// titles usually don't carry these, so strip them from both sides
// before comparing.
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
  if (query.author) params.set('artist_name', query.author)
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
