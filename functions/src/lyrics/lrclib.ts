// LRCLIB is a free, no-API-key lyrics service. We use its
// /api/get endpoint which returns one exact-match track or 404.
// Not the /api/search endpoint — that returns ranked candidates
// and would need disambiguation; LRCLIB's internal matching on
// (artist, title) is good enough for our hit rate target.

const LRCLIB_BASE_URL = 'https://lrclib.net/api/get'

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

export async function fetchFromLrclib(query: LrclibQuery): Promise<LrclibResult> {
  const params = new URLSearchParams()
  if (query.author) params.set('artist_name', query.author)
  params.set('track_name', query.title)
  const url = `${LRCLIB_BASE_URL}?${params.toString()}`

  const res = await fetch(url, { method: 'GET' })

  if (res.status === 404) {
    return { found: false, plainLyrics: null, instrumental: false, lrclibId: null }
  }
  if (!res.ok) {
    throw new Error(`LRCLIB request failed: HTTP ${res.status}`)
  }

  const body = (await res.json()) as LrclibTrackResponse
  return {
    found: true,
    plainLyrics: body.plainLyrics,
    instrumental: body.instrumental,
    lrclibId: body.id,
  }
}
